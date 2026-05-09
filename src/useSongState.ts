import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type Dispatch,
    type SetStateAction,
} from "react";
import { LyricsResponseSchema, type CommandMessage, type CommandSymbol, type MediaState } from "./schemas";
import Liricle from "liricle";
import { useQuery } from "@tanstack/react-query";
import { Value } from "@sinclair/typebox/value";

type ArtworkState = {
    data: string;
    imageUrl: string;
    mimeType: string;
};

type PlaybackOverride = {
    elapsedMicros: number;
    startedAtMs: number;
    playing: boolean;
    playbackRate: number;
    trackKey: string;
};

// exactly what it sounds like
function getSocketUrl(): string {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${location.host}/ws`;
}

// get track key
function getTrackKey(mediaState: MediaState | null): string {
    if (!mediaState?.title) {
        return "";
    }

    return `${mediaState.title}::${mediaState.artist ?? ""}::${mediaState.album ?? ""}`;
}

// thin wrapper over the websocket itself
function useMediaState() {
    const [mediaState, setMediaState] = useState<MediaState | null>(null);
    const [isReady, setIsReady] = useState(false);

    const socketRef = useRef<WebSocket | null>(null);

    useEffect(() => {
        const socket = new WebSocket(getSocketUrl());
        socketRef.current = socket;

        socket.addEventListener("open", () => {
            setIsReady(true);
        });

        socket.addEventListener("message", (event) => {
            try {
                const nextState = JSON.parse(String(event.data)) as MediaState;
                setMediaState(nextState);
            } catch {
                console.error("Invalid media state message", event.data);
            }
        });

        socket.addEventListener("close", () => {
            setIsReady(false);
        });

        socket.addEventListener("error", () => {
            setIsReady(false);
        });

        return () => {
            setIsReady(false);
            socket.close();
            socketRef.current = null;
        };
    }, []);

    const sendMessage = useCallback((message: CommandMessage) => {
        const socket = socketRef.current;
        if (!socket || socket.readyState !== WebSocket.OPEN) {
            throw new Error("Socket disconnected");
        }

        socket.send(JSON.stringify(message));
    }, []);

    const sendCommand = useCallback(
        (command: CommandSymbol): void => {
            sendMessage({ type: "command", command });
        },
        [sendMessage],
    );

    const sendSeek = useCallback(
        (positionSeconds: number): void => {
            sendMessage({ type: "seek", position: positionSeconds });
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

// handles allocating an object url
function useArtwork(mediaState: MediaState | null) {
    const [artworkState, setArtworkState] = useState<ArtworkState | null>(null);

    const artworkData = mediaState?.artworkData;
    const artworkMimeType = mediaState?.artworkMimeType;

    useEffect(() => {
        if (!artworkData || !artworkMimeType) {
            setArtworkState(null);
            return;
        }

        const binary = Uint8Array.from(atob(artworkData), (char) =>
            char.charCodeAt(0),
        );
        const imageUrl = URL.createObjectURL(
            new Blob([binary], { type: artworkMimeType }),
        );

        setArtworkState((current) => {
            if (
                current &&
                current.mimeType === artworkMimeType &&
                current.data === artworkData
            ) {
                URL.revokeObjectURL(imageUrl);
                return current;
            }

            return {
                data: artworkData,
                imageUrl,
                mimeType: artworkMimeType,
            };
        });

        return () => {
            URL.revokeObjectURL(imageUrl);
        };
    }, [artworkData, artworkMimeType]);

    return {
        artworkState,
        imageUrl: artworkState?.imageUrl ?? null,
    };
}

// caches, gets, & syncs lyrics
// lyrics are always fresh or nonexistent
function useLyrics(mediaState: MediaState | null, elapsedMicros: number) {
    const lyrics = useQuery({
        queryKey: ["lyrics", getTrackKey(mediaState)],
        queryFn: async (options) => {
            const storageKey = options.queryKey.join("::");
            const lyrics = localStorage.getItem(storageKey);
            if (lyrics) return lyrics;

            if (!mediaState) {
                return null;
            }

            const params = new URLSearchParams({
                track_name: mediaState.title!,
                artist_name: mediaState.artist!,
                album_name: mediaState.album!,
                duration: String(Math.round(mediaState.durationMicros! / 1_000_000)),
            });

            const response = await fetch(`https://lrclib.net/api/get?${params}`, {
                headers: {
                    accept: "application/json",
                },
            });

            try {
                const payload = await response.json();
                const res = Value.Parse(LyricsResponseSchema, payload);
                const lyrics = res.syncedLyrics ?? null;
                if (lyrics) {
                    localStorage.setItem(storageKey, lyrics);
                }
                return lyrics;
            } catch { return null; }
        },
    });

    const [liricle, setLiricle] = useState<Liricle | null>(null);
    const [focusedIndex, setFocusedIndex] = useState<number | null>(null);

    useEffect(() => {
        if (lyrics.data) {
            const newLiricle = new Liricle();
            newLiricle.load({ text: lyrics.data });
            newLiricle.on("sync", (e) => {
                setFocusedIndex(e?.index ?? -1);
                const focusedLine = document.getElementById(`line-${e?.index}`);
                if (focusedLine) {
                    focusedLine.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
                }
            })
            setLiricle(newLiricle);
            setFocusedIndex(-1);
        } else {
            setLiricle(null);
            setFocusedIndex(null);
        }
    }, [lyrics.data]);

    useEffect(() => {
        if (liricle) {
            liricle.sync(elapsedMicros / 1_000_000);
        }
    }, [elapsedMicros, liricle]);

    return {
        lyrics: liricle?.data?.lines,
        focusedIndex
    }
}


function getBackendElapsedMicros(mediaState: MediaState | null): number {
    if (!mediaState) {
        return 0;
    }

    const base = mediaState.elapsedTimeMicros ?? 0;
    const timestamp = mediaState.timestampEpochMicros;
    const playbackRate =
        mediaState.playbackRate ?? (mediaState.playing ? 1 : 0);

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
    trackKey: string,
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
            !trackKey ||
            trackKey !== playbackOverride.trackKey ||
            Math.abs(backendElapsed - overrideElapsed) < 1_750_000
        ) {
            setPlaybackOverride(null);
        }
    }, [mediaState, playbackOverride, trackKey]);

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
            trackKey,
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
        pendingSeekMicros,
        sendSeek,
        setStatus,
        trackKey,
    ]);

    return {
        durationMicros,
        elapsedMicros,
        handleSeekCommit,
        handleSeekInput,
        progressRatio,
    };
}

const liricle = new Liricle();

export function useSongState() {
    const { isReady, mediaState, sendCommand, sendSeek } = useMediaState();
    const [status, setStatus] = useState("Connecting…");

    const trackKey = useMemo(() => getTrackKey(mediaState), [mediaState]);
    const { artworkState, imageUrl } = useArtwork(mediaState);
    const {
        durationMicros,
        elapsedMicros,
        handleSeekCommit,
        handleSeekInput,
        progressRatio,
    } = usePlaybackClock(mediaState, trackKey, sendSeek, setStatus);
    const controlsBusy = !isReady;

    const lyrics = useLyrics(mediaState, elapsedMicros);

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
        artworkState,
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
        title: mediaState?.title ?? "Nothing playing",
        artist: mediaState?.artist ?? null,
        album: mediaState?.album ?? null,
        lyrics,
    };
}

export type { ArtworkState, MediaState };
