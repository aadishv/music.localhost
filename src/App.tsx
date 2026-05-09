import { useEffect, useRef, useState } from "react";
import { Texture } from "pixi.js";
import { LyricsScene } from "./LyricsScene";
import { useSongState } from "./useSongState";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const queryClient = new QueryClient();

const SYMBOLS = {
    play: "􀊄",
    pause: "􀊆",
    previous: "􀊊",
    next: "􀊌",
};

const symbolClassName =
    "font-['SF_Pro_Text','SF_Pro_Display','-apple-system','BlinkMacSystemFont','sans-serif'] text-[30px] leading-none [font-synthesis:none] [-webkit-font-smoothing:antialiased]";

function formatTime(micros: number): string {
    const totalSeconds = Math.max(0, Math.floor(micros / 1_000_000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function App() {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const sceneRef = useRef<LyricsScene | null>(null);
    const artworkUrlRef = useRef<string | null>(null);
    const artworkRequestIdRef = useRef(0);
    const albumPanelRef = useRef<HTMLDivElement | null>(null);
    const [albumPanelHeight, setAlbumPanelHeight] = useState(0);

    const {
        artworkState,
        controlsBusy,
        durationMicros,
        elapsedMicros,
        handleCommand,
        handleSeekCommit,
        handleSeekInput,
        imageUrl,
        mediaState,
        artist,
        album,
        progressRatio,
        title,
        lyrics,
    } = useSongState();

    useEffect(() => {
        const iconHref = imageUrl ?? "about:blank";
        let favicon =
            document.querySelector<HTMLLinkElement>("link[rel='icon']");

        if (!favicon) {
            favicon = document.createElement("link");
            favicon.rel = "icon";
            document.head.appendChild(favicon);
        }

        favicon.href = iconHref;
    }, [imageUrl]);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) {
            return;
        }

        const scene = new LyricsScene(canvas, Texture.WHITE);
        sceneRef.current = scene;

        const resize = () => {
            const activeCanvas = canvasRef.current;
            const activeScene = sceneRef.current;
            if (!activeCanvas || !activeScene) {
                return;
            }

            activeCanvas.width = window.innerWidth;
            activeCanvas.height = window.innerHeight;
            activeScene.resize(window.innerWidth, window.innerHeight);
        };

        resize();
        window.addEventListener("resize", resize);

        return () => {
            window.removeEventListener("resize", resize);
            scene.destroy();
            sceneRef.current = null;
        };
    }, []);

    useEffect(() => {
        const scene = sceneRef.current;
        if (!scene) {
            return;
        }

        const requestId = artworkRequestIdRef.current + 1;
        artworkRequestIdRef.current = requestId;

        const applyArtwork = async () => {
            if (!artworkState) {
                if (artworkUrlRef.current) {
                    URL.revokeObjectURL(artworkUrlRef.current);
                    artworkUrlRef.current = null;
                }
                scene.updateArtwork(Texture.WHITE);
                return;
            }

            if (artworkUrlRef.current) {
                URL.revokeObjectURL(artworkUrlRef.current);
            }

            const binary = Uint8Array.from(atob(artworkState.data), (char) =>
                char.charCodeAt(0),
            );
            const objectUrl = URL.createObjectURL(
                new Blob([binary], { type: artworkState.mimeType }),
            );
            artworkUrlRef.current = objectUrl;

            const image = new Image();
            image.src = objectUrl;
            await image.decode().catch(() => undefined);

            if (requestId === artworkRequestIdRef.current) {
                scene.updateArtwork(image);
            }
        };

        void applyArtwork();

        return () => {
            if (requestId === artworkRequestIdRef.current) {
                artworkRequestIdRef.current += 1;
            }
        };
    }, [artworkState]);

    useEffect(() => {
        const isEditableTarget = (target: EventTarget | null): boolean => {
            if (!(target instanceof HTMLElement)) {
                return false;
            }

            return (
                target.isContentEditable ||
                target instanceof HTMLInputElement ||
                target instanceof HTMLTextAreaElement ||
                target instanceof HTMLSelectElement
            );
        };

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.repeat || isEditableTarget(event.target)) {
                return;
            }

            if (event.key === " " || event.code === "Space") {
                event.preventDefault();
                void handleCommand("_");
                return;
            }

            if (event.key === "ArrowLeft") {
                event.preventDefault();
                void handleCommand("<");
                return;
            }

            if (event.key === "ArrowRight") {
                event.preventDefault();
                void handleCommand(">");
            }
        };

        window.addEventListener("keydown", handleKeyDown);
        return () => {
            window.removeEventListener("keydown", handleKeyDown);
        };
    }, [handleCommand]);

    useEffect(() => {
        const albumPanel = albumPanelRef.current;
        if (!albumPanel) {
            return;
        }

        const updateHeight = () => {
            setAlbumPanelHeight(albumPanel.getBoundingClientRect().height);
        };

        updateHeight();

        const observer = new ResizeObserver(() => {
            updateHeight();
        });
        observer.observe(albumPanel);

        return () => {
            observer.disconnect();
        };
    }, [imageUrl, mediaState?.durationMicros, title, artist, album]);

    return (
        <div className="flex h-screen w-screen inset-0 fixed items-center gap-10">
            <canvas
                ref={canvasRef}
                className="fixed inset-0 block h-screen w-screen"
            />
            <section className="z-1 mx-auto flex items-start gap-10">
                <div ref={albumPanelRef} className="flex max-w-100 flex-col">
                    <img
                        src={imageUrl ?? undefined}
                        alt="Album artwork"
                        className="size-full object-cover aspect-square mb-5 max-w-100 rounded-lg"
                    />

                    <h1 className="m-0 font-sans text-lg text-white font-bold">
                        {title}
                    </h1>

                    <p className="mt-1 flex font-sans text-white/70 font-medium">
                        <span className="mr-auto ">{artist}</span>
                        <span className="ml-auto">{album}</span>
                    </p>

                    <div
                        className={
                            mediaState?.durationMicros
                                ? "mt-5 sm:mt-6"
                                : "hidden"
                        }
                    >
                        <div className="relative">
                            <div className="h-2 w-full overflow-hidden rounded-full bg-white/20">
                                <div
                                    className="h-full rounded-full bg-[rgba(255,245,240,0.94)]"
                                    style={{
                                        width: `${progressRatio * 100}%`,
                                    }}
                                />
                            </div>
                            <input
                                className="absolute inset-x-0 -inset-y-2.5 m-0 w-full cursor-pointer opacity-0 disabled:cursor-default"
                                type="range"
                                min="0"
                                max="1"
                                step="0.001"
                                value={progressRatio}
                                aria-label="Seek"
                                disabled={controlsBusy || !durationMicros}
                                onInput={(event) => {
                                    handleSeekInput(event.currentTarget.value);
                                }}
                                onChange={() => {
                                    void handleSeekCommit();
                                }}
                            />
                        </div>

                        <div className="mt-2 flex justify-between gap-4 font-mono font-medium text-sm text-white/70">
                            <span>{formatTime(elapsedMicros)}</span>
                            <span>
                                -
                                {formatTime(
                                    Math.max(durationMicros - elapsedMicros, 0),
                                )}
                            </span>
                        </div>

                        <div className="mt-4.5 flex items-center justify-center text-white">
                            <button
                                className="size-14 flex-1"
                                aria-label="Previous track"
                                disabled={
                                    controlsBusy ||
                                    Boolean(mediaState?.prohibitsSkip)
                                }
                                onClick={() => {
                                    void handleCommand("<");
                                }}
                            >
                                <span className={symbolClassName}>
                                    {SYMBOLS.previous}
                                </span>
                            </button>
                            <button
                                className="size-14 flex-1"
                                aria-label="Play or pause"
                                disabled={controlsBusy}
                                onClick={() => {
                                    void handleCommand("_");
                                }}
                            >
                                <span
                                    className={`${symbolClassName} text-[44px]`}
                                >
                                    {mediaState?.playing
                                        ? SYMBOLS.pause
                                        : SYMBOLS.play}
                                </span>
                            </button>
                            <button
                                className="size-14 flex-1"
                                aria-label="Next track"
                                disabled={
                                    controlsBusy ||
                                    Boolean(mediaState?.prohibitsSkip)
                                }
                                onClick={() => {
                                    void handleCommand(">");
                                }}
                            >
                                <span className={symbolClassName}>
                                    {SYMBOLS.next}
                                </span>
                            </button>
                        </div>
                    </div>
                </div>
                {lyrics.lyrics && (
                    <div
                        className="max-w-100 overflow-y-auto whitespace-pre-wrap text-3xl font-bold flex gap-5 py-24 flex-col font-sans tracking-tight text-white no-scrollbar"
                        style={{
                            height: albumPanelHeight || undefined,
                            maskImage:
                                "linear-gradient(to bottom, transparent, black 20%, black 80%, transparent)",
                        }}
                    >
                        {lyrics.lyrics.map((line, index) => (
                            <div
                                key={index}
                                id={`line-${index}`}
                                className={
                                    "px-2" +
                                    (lyrics.focusedIndex === index
                                        ? ""
                                        : " text-white/50 blur-[2px] transition-all")
                                }
                            >
                                {line.text}
                            </div>
                        ))}
                    </div>
                )}
            </section>
        </div>
    );
}

export function WrappedApp() {
    return (
        <QueryClientProvider client={queryClient}>
            <App />
        </QueryClientProvider>
    );
}
