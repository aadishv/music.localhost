export default defineContentScript({
    matches: ["*://music.youtube.com/*"],
    world: "MAIN",
    runAt: "document_start",
    main() {
        console.log("[YTM-Main] Installed MediaMetadata interceptor");

        const NativeMediaMetadata = window.MediaMetadata;
        const mediaSession = navigator.mediaSession;
        if (!NativeMediaMetadata || !mediaSession) return;

        type LyricsTranslationLine = {
            startTimeMs: number;
            text: string;
        };

        type LyricsPayload = {
            lrc: string;
            translations: LyricsTranslationLine[];
            translationLanguage: string | null;
        };

        type MetadataPayload = {
            title: string;
            artist: string;
            album: string;
            artworkUrl: string | null;
            lyrics: LyricsPayload | null;
        };

        type PlayerStatePayload = {
            playing: boolean;
            durationMicros: number;
            elapsedTimeMicros: number;
            playbackRate: number;
            timestampEpochMicros: number;
        };

        let lastSentMetadataKey = "";
        let lastFetchedBrowseId = "";
        let inFlightBrowseId = "";
        let lastObservedMetadata: MediaMetadata | null = null;
        let currentMetadata: MetadataPayload | null = null;
        let lastPlayerStateKey = "";
        let videoElement: HTMLVideoElement | null = null;
        let playerBarElement: Element | null = null;
        let progressBarElement: Element | null = null;

        function postMainMessage(type: string, payload: unknown) {
            window.postMessage({ source: "ytm-main", type, payload }, "*");
        }

        function cloneValue<T>(value: T): T {
            if (typeof structuredClone === "function") return structuredClone(value);
            return JSON.parse(JSON.stringify(value));
        }

        function getHighestResolutionArtwork(
            artwork?: readonly MediaImage[],
        ): string | null {
            const getWidth = (item: MediaImage) =>
                Number.parseInt(item.sizes?.match(/(\d+)x/)?.[1] ?? "0", 10);
            return (
                artwork
                    ?.filter((art) => !!art.src)
                    .sort((a, b) => getWidth(b) - getWidth(a))[0]?.src ?? null
            );
        }

        function getLyricsBrowseId(player: any): string | null {
            const tabs =
                player?.tabs ??
                player?.watchNextResponse?.contents
                    ?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer
                    ?.watchNextTabbedResultsRenderer?.tabs ??
                [];

            const lyricsTab = tabs.find(
                (tab: any) =>
                    tab?.tabRenderer?.endpoint?.browseEndpoint
                        ?.browseEndpointContextSupportedConfigs
                        ?.browseEndpointContextMusicConfig?.pageType ===
                    "MUSIC_PAGE_TYPE_TRACK_LYRICS",
            );

            return (
                lyricsTab?.tabRenderer?.endpoint?.browseEndpoint?.browseId ??
                null
            );
        }

        function getRequestHeaders() {
            const headers: Record<string, string> = {
                "content-type": "application/json",
                "x-origin": window.location.origin,
                "x-youtube-bootstrap-logged-in": String(
                    Number(!!(window as any).ytcfg?.get?.("LOGGED_IN")),
                ),
            };

            const authUser = (window as any).ytcfg?.get?.("SESSION_INDEX");
            const visitorData = (window as any).ytcfg?.get?.("VISITOR_DATA");
            const clientName = (window as any).ytcfg?.get?.(
                "INNERTUBE_CONTEXT_CLIENT_NAME",
            );
            const clientVersion = (window as any).ytcfg?.get?.(
                "INNERTUBE_CLIENT_VERSION",
            );

            if (authUser != null) headers["x-goog-authuser"] = String(authUser);
            if (visitorData) headers["x-goog-visitor-id"] = String(visitorData);
            if (clientName != null)
                headers["x-youtube-client-name"] = String(clientName);
            if (clientVersion)
                headers["x-youtube-client-version"] = String(clientVersion);

            return headers;
        }

        function getMobileBrowseContext(targetLanguage?: string) {
            const context = (window as any).ytcfg?.get?.("INNERTUBE_CONTEXT");
            if (!context) throw new Error("Missing INNERTUBE_CONTEXT");

            const cloned = cloneValue(context);
            cloned.client.clientName = "ANDROID_MUSIC";
            cloned.client.clientVersion = "9.24.51";
            if (targetLanguage) {
                cloned.client.hl = targetLanguage;
            }
            return cloned;
        }

        function findNestedValue(value: unknown, key: string): unknown {
            let result: unknown;

            const visit = (current: unknown) => {
                if (!current || typeof current !== "object" || result !== undefined) {
                    return;
                }

                for (const [currentKey, currentValue] of Object.entries(current)) {
                    if (currentKey === key) {
                        result = currentValue;
                        return;
                    }
                    visit(currentValue);
                    if (result !== undefined) {
                        return;
                    }
                }
            };

            visit(value);
            return result;
        }

        async function browseMusic(body: Record<string, unknown>) {
            const apiKey = (window as any).ytcfg?.get?.("INNERTUBE_API_KEY");
            if (!apiKey) throw new Error("Missing INNERTUBE_API_KEY");

            const response = await fetch(
                "/youtubei/v1/browse?prettyPrint=false&key=" +
                    encodeURIComponent(apiKey),
                {
                    method: "POST",
                    credentials: "same-origin",
                    headers: getRequestHeaders(),
                    body: JSON.stringify(body),
                },
            );

            if (!response.ok) {
                throw new Error(`Lyrics fetch failed with ${response.status}`);
            }

            return response.json();
        }

        async function fetchLyricsPayload(
            browseId: string,
            trackState: { title: string; artist: string; album: string },
            targetLanguage = "en",
        ): Promise<LyricsPayload | null> {
            const data = await browseMusic({
                context: getMobileBrowseContext(),
                browseId,
            });

            const timedLyricsData =
                data?.contents?.elementRenderer?.newElement?.type?.componentType
                    ?.model?.timedLyricsModel?.lyricsData?.timedLyricsData;

            (window as any).__ytmLyricsDebug = {
                browseId,
                source: data,
                translation: null,
            };

            if (!Array.isArray(timedLyricsData) || timedLyricsData.length === 0) {
                return null;
            }

            const translationTokenRaw = findNestedValue(
                data,
                "translationContinuationToken",
            );

            let translations: LyricsTranslationLine[] = [];
            if (typeof translationTokenRaw === "string" && translationTokenRaw) {
                const translationData = await browseMusic({
                    context: getMobileBrowseContext(targetLanguage),
                    continuation: decodeURIComponent(translationTokenRaw),
                });

                (window as any).__ytmLyricsDebug.translation = translationData;
                console.log("[YTM-Main] Raw lyrics debug", (window as any).__ytmLyricsDebug);

                const translatedLines =
                    translationData?.continuationContents?.musicLyricsContinuation
                        ?.lyricsTranslations;

                if (Array.isArray(translatedLines)) {
                    translations = translatedLines.map((line: any, index: number) => ({
                        startTimeMs: Number(
                            timedLyricsData[index]?.cueRange
                                ?.startTimeMilliseconds ?? 0,
                        ),
                        text:
                            typeof line?.translatedLyricText === "string"
                                ? line.translatedLyricText
                                : "",
                    }));
                }
            }

            console.log("[YTM-Main] Extracted lyrics debug", {
                originalCount: timedLyricsData.length,
                translationCount: translations.length,
                originalPreview: timedLyricsData.slice(0, 20).map((line: any) => ({
                    startTimeMilliseconds: line?.cueRange?.startTimeMilliseconds,
                    lyricLine: line?.lyricLine,
                })),
                translationPreview: translations.slice(0, 20),
            });

            return {
                lrc: toLrc(trackState, timedLyricsData),
                translations,
                translationLanguage: translations.length > 0 ? targetLanguage : null,
            };
        }

        function formatLrcTimestamp(milliseconds: number) {
            const totalMs = Math.max(0, Number(milliseconds) || 0);
            const minutes = Math.floor(totalMs / 60_000);
            const seconds = Math.floor(totalMs / 1_000) % 60;
            const centiseconds = Math.floor((totalMs % 1_000) / 10);
            return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(centiseconds).padStart(2, "0")}`;
        }

        function sanitizeLrcTag(value: string) {
            return String(value)
                .replace(/[\[\]\r\n]/g, " ")
                .trim();
        }

        function toLrc(
            trackState: { title: string; artist: string; album: string },
            timedLyricsData: any[],
        ) {
            const lines = [];

            if (trackState.title) lines.push(`[ti:${sanitizeLrcTag(trackState.title)}]`);
            if (trackState.artist) lines.push(`[ar:${sanitizeLrcTag(trackState.artist)}]`);
            if (trackState.album) lines.push(`[al:${sanitizeLrcTag(trackState.album)}]`);

            for (const line of timedLyricsData) {
                const startMs = line?.cueRange?.startTimeMilliseconds;
                if (startMs == null) continue;

                const timestamp = formatLrcTimestamp(startMs);
                const text =
                    typeof line?.lyricLine === "string" ? line.lyricLine : "";
                const segments = text.replace(/\r/g, "").split("\n");

                for (const segment of segments) {
                    lines.push(`[${timestamp}]${segment}`);
                }
            }

            return lines.join("\n");
        }

        function readNumericValueFromElement(element: Element | null) {
            if (!element) return 0;

            const valueFromProperty = (element as HTMLInputElement).value;
            const valueFromAttribute = element.getAttribute("value");
            const valueFromAria = element.getAttribute("aria-valuenow");
            const numeric = Number(
                valueFromProperty ?? valueFromAttribute ?? valueFromAria ?? 0,
            );

            return Number.isFinite(numeric) ? numeric : 0;
        }

        function readDurationSeconds(video: HTMLVideoElement, progressBar: Element | null) {
            const progressMax = Number(
                progressBar?.getAttribute("max") ??
                    progressBar?.getAttribute("aria-valuemax") ??
                    NaN,
            );

            if (Number.isFinite(progressMax) && progressMax > 0) {
                return progressMax;
            }

            return Number.isFinite(video.duration) && video.duration > 0
                ? video.duration
                : 0;
        }

        function emitPlayerState(force = false) {
            const video = videoElement ?? document.querySelector("video");
            if (!(video instanceof HTMLVideoElement)) return;

            videoElement = video;
            const progressBar =
                progressBarElement ?? document.querySelector("#progress-bar");
            if (progressBar) progressBarElement = progressBar;

            const elapsedSeconds = Math.max(
                0,
                readNumericValueFromElement(progressBar),
            );
            const durationSeconds = Math.max(
                0,
                readDurationSeconds(video, progressBar),
            );

            const payload: PlayerStatePayload = {
                playing: !video.paused,
                durationMicros: Math.round(durationSeconds * 1_000_000),
                elapsedTimeMicros: Math.round(elapsedSeconds * 1_000_000),
                playbackRate: video.paused ? 0 : video.playbackRate || 1,
                timestampEpochMicros: Date.now() * 1000,
            };

            const nextKey = [
                payload.playing ? "1" : "0",
                payload.durationMicros,
                payload.elapsedTimeMicros,
                payload.playbackRate,
            ].join(":");

            if (!force && nextKey === lastPlayerStateKey) return;
            lastPlayerStateKey = nextKey;
            postMainMessage("PLAYER_STATE_UPDATE", payload);
        }

        function setupVideoListeners(video: HTMLVideoElement) {
            if (
                (video as { __ytmMainListenersInstalled?: boolean })
                    .__ytmMainListenersInstalled
            ) {
                return;
            }

            (video as { __ytmMainListenersInstalled?: boolean }).__ytmMainListenersInstalled = true;
            videoElement = video;

            const events = [
                "play",
                "pause",
                "ratechange",
                "loadedmetadata",
                "durationchange",
                "seeking",
                "seeked",
                "emptied",
                "ended",
            ] as const;

            for (const eventName of events) {
                video.addEventListener(eventName, () => emitPlayerState(true));
            }
        }

        function setupProgressBarObserver(progressBar: Element) {
            if ((progressBar as { __ytmProgressObserverInstalled?: boolean }).__ytmProgressObserverInstalled) {
                return;
            }

            (progressBar as { __ytmProgressObserverInstalled?: boolean }).__ytmProgressObserverInstalled = true;
            progressBarElement = progressBar;

            const observer = new MutationObserver(() => {
                emitPlayerState(true);
            });

            observer.observe(progressBar, {
                attributes: true,
                attributeFilter: ["value", "aria-valuenow", "max", "aria-valuemax"],
            });
        }

        function setupPlayerBarListeners(playerBar: Element) {
            if ((playerBar as { __ytmVideoDataChangeInstalled?: boolean }).__ytmVideoDataChangeInstalled) {
                return;
            }

            (playerBar as { __ytmVideoDataChangeInstalled?: boolean }).__ytmVideoDataChangeInstalled = true;
            playerBarElement = playerBar;

            playerBar.addEventListener("videodatachange", () => {
                maybeAttachPageObservers();
                const metadata = navigator.mediaSession.metadata ?? lastObservedMetadata;
                if (metadata) {
                    void checkAndUpdate(metadata);
                }
                emitPlayerState(true);
            });
        }

        function maybeAttachPageObservers() {
            const video = document.querySelector("video");
            if (video instanceof HTMLVideoElement) {
                setupVideoListeners(video);
            }

            const progressBar = document.querySelector("#progress-bar");
            if (progressBar) {
                setupProgressBarObserver(progressBar);
            }

            const playerBar = document.querySelector("ytmusic-player-bar");
            if (playerBar) {
                setupPlayerBarListeners(playerBar);
            }
        }

        async function checkAndUpdate(metadata: MediaMetadata) {
            const title = metadata.title || "";
            const artist = metadata.artist || "";
            const album = metadata.album || "";
            const artworkUrl = getHighestResolutionArtwork(metadata.artwork);
            const metadataKey = `${title}::${artist}::${album}::${artworkUrl}`;

            if (metadataKey !== lastSentMetadataKey) {
                lastSentMetadataKey = metadataKey;
                lastFetchedBrowseId = "";
                inFlightBrowseId = "";
                currentMetadata = {
                    title,
                    artist,
                    album,
                    artworkUrl,
                    lyrics: null,
                };
                postMainMessage("METADATA_UPDATE", currentMetadata);
                emitPlayerState(true);
            }

            const player = document.querySelector("ytmusic-player-page");
            const browseId = getLyricsBrowseId(player);
            if (
                !browseId ||
                browseId === lastFetchedBrowseId ||
                browseId === inFlightBrowseId
            ) {
                return;
            }

            inFlightBrowseId = browseId;
            try {
                const lyrics = await fetchLyricsPayload(browseId, {
                    title,
                    artist,
                    album,
                });
                lastFetchedBrowseId = browseId;

                if (lyrics) {
                    currentMetadata = {
                        title,
                        artist,
                        album,
                        artworkUrl,
                        lyrics,
                    };
                    postMainMessage("METADATA_UPDATE", currentMetadata);
                }
            } catch (error) {
                console.error("[YTM-Main] Failed to fetch timed lyrics", error);
            } finally {
                if (inFlightBrowseId === browseId) inFlightBrowseId = "";
            }
        }

        function observeMetadata(metadata: MediaMetadata | null | undefined) {
            if (!metadata) return;
            lastObservedMetadata = metadata;
            void checkAndUpdate(metadata);
        }

        const mediaSessionPrototype = Object.getPrototypeOf(mediaSession);
        const metadataDescriptor = Object.getOwnPropertyDescriptor(
            mediaSessionPrototype,
            "metadata",
        );

        if (metadataDescriptor?.get && metadataDescriptor.set) {
            Object.defineProperty(mediaSessionPrototype, "metadata", {
                configurable: true,
                enumerable: metadataDescriptor.enumerable ?? false,
                get() {
                    return metadataDescriptor.get!.call(this);
                },
                set(value: MediaMetadata | null) {
                    metadataDescriptor.set!.call(this, value);
                    if (this === mediaSession) observeMetadata(value);
                },
            });
        } else {
            class PatchedMediaMetadata extends NativeMediaMetadata {
                constructor(init?: MediaMetadataInit) {
                    super(init);
                    observeMetadata(this);
                }
            }

            Object.defineProperty(PatchedMediaMetadata, "name", {
                value: "MediaMetadata",
            });
            (window as any).MediaMetadata = PatchedMediaMetadata;
        }

        const pageObserver = new MutationObserver(() => {
            maybeAttachPageObservers();
        });

        pageObserver.observe(document.documentElement, {
            childList: true,
            subtree: true,
        });

        maybeAttachPageObservers();

        window.addEventListener("message", (event) => {
            if (!event.data || event.data.source !== "ytm-isolated") return;

            const video = videoElement ?? document.querySelector("video");
            if (!(video instanceof HTMLVideoElement)) return;

            if (event.data.type === "COMMAND") {
                const { command } = event.data.payload ?? {};

                if (command === "_") {
                    if (video.paused) {
                        video.play().catch(() => {
                            const playBtn =
                                document.querySelector<HTMLElement>(
                                    "#play-pause-button",
                                ) ||
                                document.querySelector<HTMLElement>(
                                    ".play-pause-button",
                                );
                            playBtn?.click();
                        });
                    } else {
                        video.pause();
                    }
                } else if (command === "<") {
                    const prevBtn =
                        document.getElementById("previous-button") ||
                        document.querySelector<HTMLElement>(
                            ".previous-button",
                        ) ||
                        document.querySelector<HTMLElement>(
                            'button[aria-label="Previous track"]',
                        );
                    prevBtn?.click();
                } else if (command === ">") {
                    const nextBtn =
                        document.getElementById("next-button") ||
                        document.querySelector<HTMLElement>(".next-button") ||
                        document.querySelector<HTMLElement>(
                            'button[aria-label="Next track"]',
                        );
                    nextBtn?.click();
                }
            } else if (event.data.type === "SEEK") {
                const position = Number(event.data.payload?.position);
                if (Number.isFinite(position)) {
                    video.currentTime = position;
                }
            }
        });

        setInterval(() => {
            const metadata = navigator.mediaSession.metadata ?? lastObservedMetadata;
            if (metadata) void checkAndUpdate(metadata);
        }, 1500);
    },
});
