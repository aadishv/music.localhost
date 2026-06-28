import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type Dispatch,
    type SetStateAction,
} from "react";
import Liricle from "liricle";

export type LyricsTranslationLine = {
    startTimeMs: number;
    text: string;
};

export type LyricsPayload = {
    lrc: string;
    translations: LyricsTranslationLine[];
    translationLanguage: string | null;
};

export interface MediaState {
  title?: string;
  artist?: string;
  album?: string;
  artworkUrl?: string | null;
  playing?: boolean;
  durationMicros?: number;
  elapsedTimeMicros?: number;
  timestampEpochMicros?: number;
  playbackRate?: number;
  prohibitsSkip?: boolean;
  instrumental?: boolean;
  lyrics?: LyricsPayload | null;
}

export type CommandSymbol = "<" | "_" | ">" | ">>" | "<<" | "|<<" | "|>>";

type PlaybackOverride = {
    elapsedMicros: number;
    startedAtMs: number;
    playing: boolean;
    playbackRate: number;
    title: string;
};

declare global {
    interface Window {
        setLrcLyrics: (lyrics: string) => void;
        resetLrcLyrics: () => void;
    }
}

const LRC_OVERRIDE_EVENT = "lrc-lyrics-override-change";
let lrcLyricsOverride: string | null = null;

function setLrcLyricsOverride(lyrics: string | null): void {
    lrcLyricsOverride = lyrics;
    window.dispatchEvent(new Event(LRC_OVERRIDE_EVENT));
}

function useMediaState() {
    const [mediaState, setMediaState] = useState<MediaState | null>(null);
    const [isReady, setIsReady] = useState(false);
    const portRef = useRef<any>(null);

    useEffect(() => {
        // Connect to background script
        const port = browser.runtime.connect({ name: 'visualizer' });
        portRef.current = port;
        setIsReady(true);

        const handleMessage = (message: any) => {
            if (message.type === 'STATE_UPDATE') {
                const state = message.payload as MediaState;
                setMediaState(state);
            }
        };

        port.onMessage.addListener(handleMessage);

        const handleDisconnect = () => {
            setIsReady(false);
            portRef.current = null;
        };
        port.onDisconnect.addListener(handleDisconnect);

        return () => {
            setIsReady(false);
            port.disconnect();
            portRef.current = null;
        };
    }, []);

    const sendMessage = useCallback((message: any) => {
        const port = portRef.current;
        if (!port) {
            console.error("Extension background port is disconnected");
            return;
        }
        port.postMessage(message);
    }, []);

    const sendCommand = useCallback(
        (command: CommandSymbol): void => {
            sendMessage({ type: "COMMAND", command });
        },
        [sendMessage],
    );

    const sendSeek = useCallback(
        (positionSeconds: number): void => {
            sendMessage({ type: "SEEK", position: positionSeconds });
        },
        [sendMessage],
    );

    return {
        isReady,
        mediaState,
        sendCommand,
        sendSeek,
    };
}

type LiricleLine = {
    index?: number;
    time: number;
    text: string;
    words?: Array<{ index?: number; time: number; text: string }> | null;
};

type VisualizerLyricsLine = LiricleLine & {
    translatedText: string | null;
};

function normalizeLyricText(text: string): string {
    return text
        .normalize("NFKC")
        .replace(/[♪♫♬♩♭♯·•・,.;:!?()[\]{}"'`~\-_/\\|]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toLocaleLowerCase();
}

function shouldConsumeTranslation(text: string): boolean {
    const normalized = normalizeLyricText(text);

    if (!normalized) {
        return false;
    }

    return /[\p{L}\p{N}]/u.test(normalized);
}

function mapTranslationsToLines(
    lines: LiricleLine[],
    translations: LyricsTranslationLine[],
): VisualizerLyricsLine[] {
    let translationIndex = 0;

    return lines.map((line) => {
        const rawTranslatedText = shouldConsumeTranslation(line.text)
            ? translations[translationIndex++]?.text ?? null
            : null;
        const translatedText =
            rawTranslatedText &&
            normalizeLyricText(rawTranslatedText) !== normalizeLyricText(line.text)
                ? rawTranslatedText
                : null;

        return {
            ...line,
            translatedText,
        };
    });
}

function useLyrics(
    lyricsData: LyricsPayload | null,
    elapsedMicros: number,
) {
    const [overrideLyrics, setOverrideLyrics] = useState<string | null>(lrcLyricsOverride);

    useEffect(() => {
        const handleOverrideChange = () => {
            setOverrideLyrics(lrcLyricsOverride);
        };

        window.addEventListener(LRC_OVERRIDE_EVENT, handleOverrideChange);
        return () => {
            window.removeEventListener(LRC_OVERRIDE_EVENT, handleOverrideChange);
        };
    }, []);

    const activeLyrics = overrideLyrics ?? lyricsData?.lrc ?? null;

    const [liricleInstance, setLiricleInstance] = useState<Liricle | null>(null);
    const [focusedIndex, setFocusedIndex] = useState<number | null>(null);

    useEffect(() => {
        if (activeLyrics) {
            const newLiricle = new Liricle();
            newLiricle.offset = 300;
            newLiricle.load({ text: activeLyrics });
            newLiricle.on("sync", (e) => {
                setFocusedIndex(e?.index ?? -1);
                const focusedLine = document.getElementById(`line-${e?.index}`);
                if (focusedLine) {
                    focusedLine.scrollIntoView({
                        behavior: "smooth",
                        block: "center",
                        inline: "center",
                    });
                }
            });
            setLiricleInstance(newLiricle);
            setFocusedIndex(-1);
        } else {
            setLiricleInstance(null);
            setFocusedIndex(null);
        }
    }, [activeLyrics]);

    useEffect(() => {
        if (liricleInstance) {
            liricleInstance.sync(elapsedMicros / 1_000_000);
        }
    }, [elapsedMicros, liricleInstance]);

    const lines = useMemo(
        () =>
            mapTranslationsToLines(
                liricleInstance?.data?.lines ?? [],
                lyricsData?.translations ?? [],
            ),
        [liricleInstance?.data?.lines, lyricsData?.translations],
    );

    return {
        lyrics: lines,
        focusedIndex,
        translationLanguage: lyricsData?.translationLanguage ?? null,
    };
}

function getBackendElapsedMicros(mediaState: MediaState | null): number {
    if (!mediaState) {
        return 0;
    }

    const base = mediaState.elapsedTimeMicros ?? 0;
    const timestamp = mediaState.timestampEpochMicros;
    const playbackRate = mediaState.playbackRate ?? (mediaState.playing ? 1 : 0);

    if (!mediaState.playing || !timestamp || playbackRate <= 0) {
        return base;
    }

    return Math.max(0, base + (Date.now() * 1000 - timestamp) * playbackRate);
}

function getOverrideElapsedMicros(override: PlaybackOverride | null): number {
    if (!override) {
        return 0;
    }

    if (!override.playing || override.playbackRate <= 0) {
        return Math.max(0, override.elapsedMicros);
    }

    return Math.max(
        0,
        override.elapsedMicros +
            (Date.now() - override.startedAtMs) * 1000 * override.playbackRate,
    );
}

function usePlaybackClock(
    mediaState: MediaState | null,
    sendSeek: (positionSeconds: number) => void,
    setStatus: Dispatch<SetStateAction<string>>,
) {
    const [playbackOverride, setPlaybackOverride] =
        useState<PlaybackOverride | null>(null);
    const [isSeeking, setIsSeeking] = useState(false);
    const [pendingSeekMicros, setPendingSeekMicros] = useState<number | null>(
        null,
    );
    const [, setFrame] = useState(0);

    useEffect(() => {
        let frameId = 0;

        const tick = () => {
            setFrame((frame) => frame + 1);
            frameId = requestAnimationFrame(tick);
        };

        frameId = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(frameId);
    }, []);

    useEffect(() => {
        if (!playbackOverride) {
            return;
        }

        const backendElapsed = mediaState?.elapsedTimeMicros ?? 0;
        const overrideElapsed = getOverrideElapsedMicros(playbackOverride);

        if (
            !mediaState?.title ||
            mediaState.title !== playbackOverride.title ||
            Math.abs(backendElapsed - overrideElapsed) < 1_750_000
        ) {
            setPlaybackOverride(null);
        }
    }, [mediaState, playbackOverride]);

    const durationMicros = mediaState?.durationMicros ?? 0;
    const elapsedMicros =
        isSeeking && pendingSeekMicros !== null
            ? pendingSeekMicros
            : playbackOverride
              ? getOverrideElapsedMicros(playbackOverride)
              : getBackendElapsedMicros(mediaState);
    const progressRatio =
        durationMicros > 0 ? Math.min(elapsedMicros / durationMicros, 1) : 0;

    const handleSeekInput = useCallback(
        (value: string): void => {
            setIsSeeking(true);
            setPendingSeekMicros(durationMicros * Number(value));
        },
        [durationMicros],
    );

    const handleSeekCommit = useCallback(async (): Promise<void> => {
        setIsSeeking(false);

        if (pendingSeekMicros === null) {
            return;
        }

        const targetMicros = Math.max(
            0,
            Math.min(pendingSeekMicros, durationMicros),
        );
        setPendingSeekMicros(null);
        setPlaybackOverride({
            elapsedMicros: targetMicros,
            startedAtMs: Date.now(),
            playing: Boolean(mediaState?.playing),
            playbackRate:
                mediaState?.playbackRate ?? (mediaState?.playing ? 1 : 0),
            title: mediaState?.title ?? "",
        });

        try {
            sendSeek(targetMicros / 1_000_000);
        } catch (error) {
            setPlaybackOverride(null);
            setStatus(error instanceof Error ? error.message : "Seek failed");
        }
    }, [
        durationMicros,
        mediaState?.playing,
        mediaState?.playbackRate,
        mediaState?.title,
        pendingSeekMicros,
        sendSeek,
        setStatus,
    ]);

    return {
        durationMicros,
        elapsedMicros,
        handleSeekCommit,
        handleSeekInput,
        progressRatio,
    };
}

if (typeof window !== "undefined") {
    window.setLrcLyrics = (lyrics: string) => {
        setLrcLyricsOverride(lyrics);
    };
    window.resetLrcLyrics = () => {
        setLrcLyricsOverride(null);
    };
}

export function useSongState() {
    const { isReady, mediaState, sendCommand, sendSeek } =
        useMediaState();
    const [status, setStatus] = useState("Connecting…");

    const imageUrl = mediaState?.artworkUrl ?? null;

    const {
        durationMicros,
        elapsedMicros,
        handleSeekCommit,
        handleSeekInput,
        progressRatio,
    } = usePlaybackClock(mediaState, sendSeek, setStatus);
    const controlsBusy = !isReady;

    const lyrics = useLyrics(mediaState?.lyrics ?? null, elapsedMicros);

    useEffect(() => {
        if (!lyrics.lyrics.length) {
            return;
        }

        console.log("[Visualizer] Lyrics with translations", lyrics.lyrics.map((line) => ({
            time: line.time,
            original: line.text,
            translated: line.translatedText,
        })));
    }, [lyrics.lyrics]);

    useEffect(() => {
        if (!mediaState?.title) {
            setStatus(isReady ? "Idle" : "Connecting…");
            return;
        }

        setStatus(mediaState.playing ? "Playing" : "Paused");
    }, [isReady, mediaState]);

    const handleCommand = useCallback(
        async (command: CommandSymbol): Promise<void> => {
            try {
                sendCommand(command);
            } catch (error) {
                setStatus(
                    error instanceof Error ? error.message : "Control failed",
                );
            }
        },
        [sendCommand],
    );

    return {
        controlsBusy,
        durationMicros,
        elapsedMicros,
        handleCommand,
        handleSeekCommit,
        handleSeekInput,
        imageUrl,
        mediaState,
        progressRatio,
        status,
        title: mediaState?.title ?? "",
        artist: mediaState?.artist ?? null,
        album: mediaState?.album ?? null,
        lyrics,
    };
}
