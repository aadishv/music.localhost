import { Value } from "@sinclair/typebox/value";
import html from "../index.html";
import {
    CommandMessageSchema,
    LyricsResponse,
    LyricsResponseSchema,
    MediaStateSchema,
    StreamMessageSchema,
    type CommandSymbol,
    type MediaState,
} from "./schemas";

class PlaybackManager {
    stream: Bun.Subprocess<"pipe", "pipe", "pipe">;
    state: MediaState;
    cacheFile: Bun.BunFile;

    private getAdapterPath(): string[] {
        return [
            "/usr/bin/perl",
            "/opt/homebrew/opt/media-control/lib/media-control/mediaremote-adapter.pl",
            "/opt/homebrew/opt/media-control/Frameworks/MediaRemoteAdapter.framework",
        ];
    }

    private getTrackKey() {
        if (
            !this.state.title ||
            !this.state.artist ||
            !this.state.album ||
            !this.state.durationMicros
        )
            return null;
        return `${this.state.album}:${this.state.artist}:${this.state.title}:${Math.round(this.state.durationMicros / 1_000_000)}`;
    }

    private async handleNewMessage(message: MediaState, diff: boolean) {
        if (!diff) {
            this.state = message;
        } else {
            this.state = { ...this.state, ...message };
        }
        server.publish("state", JSON.stringify(this.state));
    }

    async watchStream() {
        setInterval(() => {
            void (async () => {
                this.forceRefresh();
            })();
        }, 2000);

        const parseLine = async (line: string) => {
            try {
                const json = JSON.parse(line);
                const streamLine = Value.Parse(StreamMessageSchema, json);
                if (streamLine.type !== "data") return;
                await this.handleNewMessage(streamLine.payload, streamLine.diff);
            } catch {}
        };

        const reader = this.stream.stdout.getReader();
        const decoder = new TextDecoder();
        let text = "";
        while (true) {
            const { done, value } = await reader.read();

            if (done) break;

            text += decoder.decode(value);

            const lastNewline = text.lastIndexOf("\n");
            const newlyFinishedLines = text.slice(0, lastNewline);
            text = text.slice(lastNewline);

            if (newlyFinishedLines) {
                for (const line of newlyFinishedLines.split("\n")) {
                    await parseLine(line);
                }
            }
        }

        await parseLine(text);
    }

    async forceRefresh() {
        const proc = Bun.spawn([...this.getAdapterPath(), "get", "--micros"]);
        await proc.exited;
        const text = await new Response(proc.stdout).text();
        try {
            const json = JSON.parse(text);
            const message = Value.Parse(MediaStateSchema, json);
            await this.handleNewMessage(message, false);
        } catch {}
    }

    async seek(position: number) {
        const proc = Bun.spawn([
            ...this.getAdapterPath(),
            "seek",
            (position * 1000_000).toFixed(0),
        ]);
        await proc.exited;
        await this.forceRefresh();
    }

    private getCommandId(command: CommandSymbol) {
        switch (command) {
            case "<":
                return 5; // kMRPreviousTrack
            case "_":
                return 2; // kMRTogglePlayPause
            case ">":
                return 4; // kMRNextTrack
            case "<<":
                return 10; // kMRStartBackwardSeek
            case "|<<":
                return 11; // kMREndBackwardSeek
            case ">>":
                return 8; // kMRStartForwardSeek
            case "|>>":
                return 9; // kMREndForwardSeek
        }
    }

    async control(command: CommandSymbol) {
        const proc = Bun.spawn([
            ...this.getAdapterPath(),
            "send",
            `${this.getCommandId(command)}`,
        ]);
        await proc.exited;
        await this.forceRefresh();
    }

    constructor() {
        this.stream = Bun.spawn([
            ...this.getAdapterPath(),
            "stream",
            "--debounce=80",
            "--micros",
        ]);
        this.state = {};
        this.cacheFile = Bun.file("./cache.json");
    }
}

const manager = new PlaybackManager();
await manager.forceRefresh();

const server = Bun.serve({
    port: 1234,
    routes: {
        "/": html,
        "/ws": async (req, serverInstance) => {
            const success = serverInstance.upgrade(req);
            return success
                ? undefined
                : new Response("WebSocket upgrade error", { status: 400 });
        },
    },
    websocket: {
        open(ws) {
            ws.subscribe("state");
        },
        message(_, msg) {
            let contents: string;
            if (typeof msg === "string") {
                contents = msg;
            } else {
                contents = msg.toString();
            }
            try {
                const json = JSON.parse(contents);
                const command = Value.Parse(CommandMessageSchema, json);
                if (command.type === "seek") {
                    manager.seek(command.position);
                } else if (command.type === "command") {
                    manager.control(command.command);
                }
            } catch (e) {
                console.error(e);
            }
        },
        close(ws) {
            ws.unsubscribe("state");
        },
    },
});

console.log(`Listening on http://${server.hostname}:${server.port}`);

await Promise.all([server, manager.watchStream()]);
