import { useEffect, useRef, useState } from "react";
import LyricsScene from "./LyricsScene";
import { useSongState } from "./useSongState";

const SYMBOLS = {
    play: "􀊄",
    pause: "􀊆",
    previous: "􀊊",
    next: "􀊌",
};

function formatTime(micros: number): string {
    const totalSeconds = Math.max(0, Math.floor(micros / 1_000_000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function App() {
    const albumPanelRef = useRef<HTMLDivElement | null>(null);
    const [albumPanelHeight, setAlbumPanelHeight] = useState(0);

    const {
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
                return;
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

    if (!mediaState && !imageUrl && !title && !artist && !album) {
        return (
            <div className="flex h-screen w-screen items-center justify-center bg-black text-white font-sans text-xl">
                Open YouTube Music and start playing a track...
            </div>
        );
    }

    return (
        <div className="flex h-screen w-screen inset-0 fixed items-center gap-10 bg-black overflow-hidden select-none">
            <LyricsScene artwork={imageUrl} />
            <section className="z-10 mx-auto flex items-start gap-10">
                <div ref={albumPanelRef} className="flex max-w-100 flex-col py-18">
                    <img
                        src={imageUrl ?? undefined}
                        alt="Album artwork"
                        className="size-full object-cover aspect-square mb-5 max-w-100 rounded-lg shadow-2xl"
                    />

                    <h1 className="m-0 font-sans text-xl text-white font-bold">
                        {title}
                    </h1>

                    <p className="mt-1 flex font-sans text-base text-white/70 font-medium">
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

                        <div className="mt-4.5 flex items-center text-[30px] font-sans justify-center text-white">
                            <button
                                className="size-14 flex-1 cursor-pointer disabled:opacity-50"
                                aria-label="Previous track"
                                disabled={
                                    controlsBusy ||
                                    Boolean(mediaState?.prohibitsSkip)
                                }
                                onClick={() => {
                                    void handleCommand("<");
                                }}
                            >
                                {SYMBOLS.previous}
                            </button>
                            <button
                                className="size-14 flex-1 text-[44px] cursor-pointer"
                                aria-label="Play or pause"
                                disabled={controlsBusy}
                                onClick={() => {
                                    void handleCommand("_");
                                }}
                            >
                                {mediaState?.playing
                                    ? SYMBOLS.pause
                                    : SYMBOLS.play}
                            </button>
                            <button
                                className="size-14 flex-1 cursor-pointer disabled:opacity-50"
                                aria-label="Next track"
                                disabled={
                                    controlsBusy ||
                                    Boolean(mediaState?.prohibitsSkip)
                                }
                                onClick={() => {
                                    void handleCommand(">");
                                }}
                            >
                                {SYMBOLS.next}
                            </button>
                        </div>
                    </div>
                </div>
                {lyrics.lyrics && (
                    <div
                        className="max-w-100 overflow-y-auto whitespace-pre-wrap text-3xl font-bold flex gap-5 py-24 flex-col font-sans text-white no-scrollbar"
                        style={{
                            height: albumPanelHeight || undefined,
                            maskImage:
                                "linear-gradient(to bottom, transparent, black 20%, black 80%, transparent)",
                        }}
                    >
                        {lyrics.lyrics.map((line, index) => {
                            const blur =
                                Math.log(Math.abs((lyrics.focusedIndex ?? 0) - index) * 6 + 1);
                            return (
                                <div
                                    key={index}
                                    id={`line-${index}`}
                                    className={
                                        "px-2 transition-all duration-300" +
                                        (lyrics.focusedIndex === index
                                            ? " text-white/80"
                                            : " blur-xl hover:blur-none! transition-all duration-400 text-white/30")
                                    }
                                    style={{
                                        filter: `blur(${blur}px)`,
                                    }}
                                >
                                    {line.translatedText ? (
                                        <div className="flex flex-col gap-1">
                                            <span className="text-lg font-medium text-inherit opacity-75">
                                                {line.text}
                                            </span>
                                            <span className="text-inherit">
                                                {line.translatedText}
                                            </span>
                                        </div>
                                    ) : (
                                        <span className="text-inherit">{line.text}</span>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}
            </section>
        </div>
    );
}

export function WrappedApp() {
    return <App />;
}
