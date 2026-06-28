export default defineBackground(() => {
  console.log('[Background] Service worker started');

  type LyricsTranslationLine = {
    startTimeMs: number;
    text: string;
  };

  type LyricsPayload = {
    lrc: string;
    translations: LyricsTranslationLine[];
    translationLanguage: string | null;
  };

  type MediaState = {
    title?: string;
    artist?: string;
    album?: string;
    artworkUrl?: string | null;
    lyrics?: LyricsPayload | null;
    playing?: boolean;
    durationMicros?: number;
    elapsedTimeMicros?: number;
    timestampEpochMicros?: number;
    playbackRate?: number;
  };

  type NativeHostMessage =
    | { type: 'INIT' }
    | { type: 'PLAYER_STATE'; data: Record<string, unknown> };

  const NATIVE_HOST_URL = 'ws://127.0.0.1:32145';
  const NATIVE_HOST_RECONNECT_MS = 5_000;

  let currentState: MediaState | null = null;
  let currentSourceTabId: number | null = null;
  const activePorts = new Set<browser.Runtime.Port>();
  let nativeHostSocket: WebSocket | null = null;
  let nativeHostReconnectTimer: number | null = null;
  let nativeHostInitialized = false;

  function sendNativeHostMessage(message: NativeHostMessage) {
    if (nativeHostSocket?.readyState !== WebSocket.OPEN) return;
    nativeHostSocket.send(JSON.stringify(message));
  }

  function syncCurrentStateToNativeHost() {
    if (!nativeHostInitialized || nativeHostSocket?.readyState !== WebSocket.OPEN) {
      return;
    }

    const searchQuery = [currentState?.artist, currentState?.title]
      .filter(Boolean)
      .join(' ');

    sendNativeHostMessage({
      type: 'PLAYER_STATE',
      data: {
        title: currentState?.title,
        artist: currentState?.artist,
        album: currentState?.album,
        artworkUrl: currentState?.artworkUrl ?? undefined,
        trackUrl: searchQuery
          ? `https://music.youtube.com/search?q=${encodeURIComponent(searchQuery)}`
          : undefined,
        playbackState: currentState?.playing ? 'playing' : 'paused',
        durationMs:
          typeof currentState?.durationMicros === 'number'
            ? Math.max(0, Math.round(currentState.durationMicros / 1000))
            : undefined,
        positionMs:
          typeof currentState?.elapsedTimeMicros === 'number'
            ? Math.max(0, Math.round(currentState.elapsedTimeMicros / 1000))
            : undefined,
      },
    });
  }

  function scheduleNativeHostReconnect() {
    if (nativeHostReconnectTimer != null) return;
    nativeHostReconnectTimer = self.setTimeout(() => {
      nativeHostReconnectTimer = null;
      connectNativeHost();
    }, NATIVE_HOST_RECONNECT_MS);
  }

  function connectNativeHost() {
    if (
      nativeHostSocket &&
      (nativeHostSocket.readyState === WebSocket.OPEN ||
        nativeHostSocket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    const socket = new WebSocket(NATIVE_HOST_URL);
    nativeHostSocket = socket;
    nativeHostInitialized = false;

    socket.addEventListener('open', () => {
      console.log('[Background] Connected to native host');
      sendNativeHostMessage({ type: 'INIT' });
    });

    socket.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(String(event.data)) as { type?: string };
        if (message.type === 'NATIVE_HOST_STARTED') {
          nativeHostInitialized = true;
          syncCurrentStateToNativeHost();
        }
      } catch {
        // Ignore malformed messages from the native host
      }
    });

    socket.addEventListener('close', () => {
      if (nativeHostSocket === socket) {
        nativeHostSocket = null;
        nativeHostInitialized = false;
      }
      scheduleNativeHostReconnect();
    });

    socket.addEventListener('error', () => {
      socket.close();
    });
  }

  function broadcastState() {
    for (const port of activePorts) {
      try {
        port.postMessage({ type: 'STATE_UPDATE', payload: currentState });
      } catch {
        activePorts.delete(port);
      }
    }
  }

  function clearCurrentState() {
    currentState = null;
    currentSourceTabId = null;
    pendingMetadata = null;
    pendingPlayerState = null;
    broadcastState();
    syncCurrentStateToNativeHost();
  }

  async function hasAnyYouTubeMusicTabs() {
    const tabs = await browser.tabs.query({ url: '*://music.youtube.com/*' });
    return tabs.length > 0;
  }

  connectNativeHost();

  let pendingMetadata: Partial<MediaState> | null = null;
  let pendingPlayerState: Partial<MediaState> | null = null;

  function applyPendingState(sender: browser.Runtime.MessageSender) {
    const nextState = {
      ...(pendingMetadata ?? {}),
      ...(pendingPlayerState ?? {}),
    } satisfies MediaState;

    currentState = nextState.title ? nextState : null;
    currentSourceTabId = sender.tab?.id ?? currentSourceTabId;
    broadcastState();
    syncCurrentStateToNativeHost();
  }

  browser.runtime.onMessage.addListener((message: { type?: string; payload?: MediaState }, sender) => {
    if (message.type === 'METADATA_UPDATE') {
      pendingMetadata = message.payload ?? null;
      applyPendingState(sender);
    } else if (message.type === 'PLAYER_STATE_UPDATE') {
      pendingPlayerState = message.payload ?? null;
      applyPendingState(sender);
    }
  });

  browser.tabs.onRemoved.addListener(async (tabId) => {
    if (currentSourceTabId === tabId) {
      clearCurrentState();
      return;
    }

    if (!(await hasAnyYouTubeMusicTabs())) {
      clearCurrentState();
    }
  });

  browser.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
    if (tabId !== currentSourceTabId) {
      return;
    }

    if (typeof changeInfo.url === 'string' && !changeInfo.url.startsWith('https://music.youtube.com/')) {
      if (!(await hasAnyYouTubeMusicTabs())) {
        clearCurrentState();
      } else {
        currentSourceTabId = null;
        clearCurrentState();
      }
    }
  });

  browser.runtime.onConnect.addListener((port) => {
    if (port.name === 'visualizer') {
      activePorts.add(port);
      console.log('[Background] Visualizer page connected');

      if (currentState) {
        port.postMessage({ type: 'STATE_UPDATE', payload: currentState });
      }

      port.onMessage.addListener(async (msg: unknown) => {
        const tabs = await browser.tabs.query({ url: '*://music.youtube.com/*' });
        for (const tab of tabs) {
          if (tab.id) {
            browser.tabs.sendMessage(tab.id, msg).catch(() => {
              // Ignore failure to send to closed/inactive tabs
            });
          }
        }
      });

      port.onDisconnect.addListener(() => {
        activePorts.delete(port);
        console.log('[Background] Visualizer page disconnected');
      });
    }
  });

  browser.action.onClicked.addListener(() => {
    browser.tabs.create({
      url: browser.runtime.getURL('/visualizer.html' as any),
    });
  });
});

