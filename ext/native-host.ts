import { DiscordIPC, type Activity } from './rpc.ts';
import { WebSocketServer, type WebSocket } from 'ws';

type NativeHostMessage =
  | { type: 'INIT' }
  | { type: 'PLAYER_STATE'; data?: unknown }
  | { type: 'RECONNECT_RPC' };

type NativeHostEventMessage =
  | {
      type: 'NATIVE_HOST_STARTED';
      version: string;
      transport: 'websocket';
      host: string;
      port: number;
    }
  | {
      type: 'RPC_STATUS_UPDATE';
      status: 'connected' | 'disconnected';
      user?: { username?: string; discriminator?: string };
    }
  | {
      type: 'RPC_ERROR' | 'NATIVE_HOST_ERROR' | 'NATIVE_HOST_WARNING';
      message: string;
      errorType?: string;
      errorDetails?: Record<string, unknown>;
    }
  | {
      type: 'ACTIVITY_STATUS';
      status: 'success' | 'error' | 'cleared' | 'clear_error';
      message?: string;
      activity?: unknown;
    };

type NormalizedPlayerState = {
  title?: string;
  artist?: string;
  album?: string;
  artworkUrl?: string;
  trackUrl?: string;
  playbackState?: string;
  durationMs?: number;
  positionMs?: number;
  raw: unknown;
};

const NATIVE_HOST_VERSION = '1.0.0';
const clientId = '1242988484671705208';
const WS_HOST = process.env.YTM_RPC_WS_HOST || '127.0.0.1';
const WS_PORT = Number(process.env.YTM_RPC_WS_PORT || 32145);
const EXT_POLL_INTERVAL_MS = 1_500;
const STALE_ACTIVITY_TIMEOUT_MS = EXT_POLL_INTERVAL_MS + 500;

let messageQueue: NativeHostMessage[] = [];
let rpcReady = false;
let rpcLoginPromise: Promise<void> | null = null;
let messageProcessingPromise: Promise<void> = Promise.resolve();
let staleActivityTimer: ReturnType<typeof setTimeout> | null = null;
const clients = new Set<WebSocket>();

let rpc = createRpc();
const wss = new WebSocketServer({ host: WS_HOST, port: WS_PORT });

function sendToExtension(
  messageObject: NativeHostEventMessage,
  targetClient?: WebSocket,
) {
  try {
    const jsonMessage = JSON.stringify(messageObject);
    const recipients = targetClient ? [targetClient] : [...clients];

    for (const client of recipients) {
      if (client.readyState === client.OPEN) {
        client.send(jsonMessage);
      }
    }
  } catch {
    // noop
  }
}

function logExtensionEvent(label: string, payload: unknown) {
  try {
    console.log(`[extension] ${label}: ${JSON.stringify(payload)}`);
  } catch {
    console.log(`[extension] ${label}`);
  }
}

function clearStaleActivityTimer() {
  if (staleActivityTimer) {
    clearTimeout(staleActivityTimer);
    staleActivityTimer = null;
  }
}

function armStaleActivityTimer() {
  clearStaleActivityTimer();
  staleActivityTimer = setTimeout(() => {
    logExtensionEvent('activity_stale_timeout', {
      timeoutMs: STALE_ACTIVITY_TIMEOUT_MS,
    });
    void clearActivity();
  }, STALE_ACTIVITY_TIMEOUT_MS);
}

function createRpc() {
  const nextRpc = new DiscordIPC(clientId);

  nextRpc.on('ready', () => {
    if (rpc !== nextRpc) return;

    rpcReady = true;
    sendToExtension({
      type: 'RPC_STATUS_UPDATE',
      status: 'connected',
      user: {
        username: nextRpc.user?.username,
        discriminator: nextRpc.user?.discriminator,
      },
    });

    const queue = messageQueue.filter((msg) => msg.type === 'PLAYER_STATE');
    messageQueue = [];

    for (const msg of queue) {
      void setPlayerState(msg.data);
    }
  });

  nextRpc.on('error', (err: Error) => {
    if (rpc !== nextRpc) return;

    rpcReady = false;
    sendToExtension({ type: 'RPC_ERROR', message: `RPC Error: ${err.message}` });
  });

  nextRpc.on('close', () => {
    if (rpc !== nextRpc) return;

    rpcReady = false;
    sendToExtension({ type: 'RPC_STATUS_UPDATE', status: 'disconnected' });
  });

  return nextRpc;
}

function sendCurrentStatus(targetClient?: WebSocket) {
  sendToExtension(
    {
      type: 'NATIVE_HOST_STARTED',
      version: NATIVE_HOST_VERSION,
      transport: 'websocket',
      host: WS_HOST,
      port: WS_PORT,
    },
    targetClient,
  );

  if (rpcReady && rpc.user) {
    sendToExtension(
      {
        type: 'RPC_STATUS_UPDATE',
        status: 'connected',
        user: {
          username: rpc.user.username,
          discriminator: rpc.user.discriminator,
        },
      },
      targetClient,
    );
    return;
  }

  sendToExtension(
    { type: 'RPC_STATUS_UPDATE', status: 'disconnected' },
    targetClient,
  );
}

async function handleMessage(message: NativeHostMessage) {
  logExtensionEvent('received', message);

  if (!rpcReady && message.type !== 'INIT') {
    messageQueue.push(message);
    logExtensionEvent('queued', message);
    await connectRpc();
    return;
  }

  switch (message.type) {
    case 'INIT':
      await connectRpc();
      break;
    case 'PLAYER_STATE':
      armStaleActivityTimer();
      await setPlayerState(message.data);
      break;
    case 'RECONNECT_RPC':
      await connectRpc(true);
      break;
    default:
      sendToExtension({
        type: 'NATIVE_HOST_WARNING',
        message: `Unknown message type: ${(message as { type?: string }).type}`,
      });
  }
}

wss.on('connection', (socket) => {
  clients.add(socket);
  logExtensionEvent('connected', { clients: clients.size });
  sendCurrentStatus(socket);

  socket.on('message', (rawMessage) => {
    let message: NativeHostMessage;

    try {
      message = JSON.parse(rawMessage.toString('utf8')) as NativeHostMessage;
    } catch (error) {
      sendToExtension(
        {
          type: 'NATIVE_HOST_ERROR',
          message: `Error parsing message: ${error instanceof Error ? error.message : String(error)}`,
        },
        socket,
      );
      return;
    }

    messageProcessingPromise = messageProcessingPromise
      .then(() => handleMessage(message))
      .catch((error) => {
        sendToExtension(
          {
            type: 'NATIVE_HOST_ERROR',
            message: `Error handling message: ${error instanceof Error ? error.message : String(error)}`,
          },
          socket,
        );
      });
  });

  socket.on('close', () => {
    clients.delete(socket);
    logExtensionEvent('disconnected', { clients: clients.size });
  });

  socket.on('error', (error) => {
    logExtensionEvent('socket_error', { message: error.message });
    sendToExtension({
      type: 'NATIVE_HOST_ERROR',
      message: `WebSocket Error: ${error.message}`,
    });
  });
});

wss.on('listening', () => {
  sendToExtension({
    type: 'NATIVE_HOST_STARTED',
    version: NATIVE_HOST_VERSION,
    transport: 'websocket',
    host: WS_HOST,
    port: WS_PORT,
  });
});

wss.on('error', (error) => {
  console.error('WebSocket server error:', error);
});

async function connectRpc(forceReconnect = false) {
  if (rpcReady && !forceReconnect) return;
  if (rpcLoginPromise) return rpcLoginPromise;

  rpcLoginPromise = (async () => {
    try {
      if (forceReconnect) {
        rpcReady = false;
        rpc.close();
        rpc = createRpc();
      }

      await rpc.connect();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      let errorType = 'UNKNOWN_ERROR';
      let errorMessage = error.message;

      if (/timeout|TIMED_OUT|ETIMEDOUT|RPC_CONNECTION_TIMEOUT/i.test(error.message)) {
        errorType = 'TIMEOUT_ERROR';
        errorMessage = 'Connection timed out while waiting for Discord RPC';
      } else if (/401|Unauthorized|AUTHENTICATION_FAILED/i.test(error.message)) {
        errorType = 'AUTHENTICATION_ERROR';
        errorMessage = 'Authentication failed - check client ID and Discord credentials';
      }

      console.error(`RPC Login Failed [${errorType}]:`, {
        errorType,
        errorMessage: error.message,
        stack: error.stack,
        clientId,
      });

      sendToExtension({
        type: 'RPC_ERROR',
        message: `RPC Login Failed: ${errorMessage}`,
        errorType,
        errorDetails: {
          originalMessage: error.message,
          stack: error.stack,
        },
      });
    } finally {
      rpcLoginPromise = null;
    }
  })();

  return rpcLoginPromise;
}

function getFirstString(...values: unknown[]) {
  return values.find(
    (value): value is string =>
      typeof value === 'string' && value.trim().length > 0,
  );
}

function getFirstNumber(...values: unknown[]) {
  return values.find(
    (value): value is number => typeof value === 'number' && Number.isFinite(value),
  );
}

function normalizePlayerState(playerState: unknown): NormalizedPlayerState | null {
  if (!playerState || typeof playerState !== 'object') {
    return null;
  }

  const state = playerState as Record<string, unknown>;
  const playbackState = getFirstString(
    state.playbackState,
    state.playerState,
    state.status,
    state.state,
  )?.toLowerCase();

  return {
    title: getFirstString(state.title, state.songTitle, state.name),
    artist: getFirstString(state.artist, state.artistName, state.author),
    album: getFirstString(state.album, state.albumName),
    artworkUrl: getFirstString(
      state.artworkUrl,
      state.albumArtUrl,
      state.imageUrl,
      state.thumbnailUrl,
    ),
    trackUrl: getFirstString(state.trackUrl, state.songUrl, state.url),
    playbackState,
    durationMs: getFirstNumber(state.durationMs, state.duration),
    positionMs: getFirstNumber(state.positionMs, state.position, state.currentTimeMs),
    raw: playerState,
  };
}

function buildDiscordActivity(playerState: unknown): Activity | null {
  const normalized = normalizePlayerState(playerState);
  if (!normalized || !normalized.title || normalized.playbackState === 'paused') {
    return null;
  }

  const activity: Activity = {
    details: normalized.title,
    state: normalized.artist || undefined,
    largeImageKey: normalized.artworkUrl,
    largeImageText: normalized.album || normalized.title,
    type: 2,
  };

  if (normalized.trackUrl) {
    activity.buttons = [{ label: 'Open in YouTube Music', url: normalized.trackUrl }];
  }

  if (
    typeof normalized.positionMs === 'number' &&
    typeof normalized.durationMs === 'number' &&
    normalized.durationMs > normalized.positionMs
  ) {
    const now = Date.now();
    activity.startTimestamp = Math.floor((now - normalized.positionMs) / 1000);
    activity.endTimestamp = Math.floor(
      (now + (normalized.durationMs - normalized.positionMs)) / 1000,
    );
  }

  return activity;
}

async function setPlayerState(playerState: unknown) {
  const activity = buildDiscordActivity(playerState);

  if (!activity) {
    clearStaleActivityTimer();
    logExtensionEvent('clearing_activity', {
      reason: 'paused_or_invalid',
      playerState,
    });
    await clearActivity();
    return;
  }

  logExtensionEvent('setting_activity', activity);
  await setDiscordActivity(activity);
}

async function setDiscordActivity(activityData: Activity) {
  if (!rpcReady) {
    sendToExtension({
      type: 'ACTIVITY_STATUS',
      status: 'error',
      message: 'RPC client not ready.',
    });
    return;
  }

  try {
    rpc.setActivity(activityData);
    sendToExtension({
      type: 'ACTIVITY_STATUS',
      status: 'success',
      activity: activityData,
    });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    sendToExtension({
      type: 'ACTIVITY_STATUS',
      status: 'error',
      message: `Failed to set activity: ${error.message}`,
    });
  }
}

async function clearActivity() {
  if (!rpcReady) {
    sendToExtension({
      type: 'ACTIVITY_STATUS',
      status: 'clear_error',
      message: 'RPC client not ready.',
    });
    return;
  }

  try {
    rpc.clearActivity();
    logExtensionEvent('activity_cleared', {});
    sendToExtension({ type: 'ACTIVITY_STATUS', status: 'cleared' });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    sendToExtension({
      type: 'ACTIVITY_STATUS',
      status: 'clear_error',
      message: `Failed to clear activity: ${error.message}`,
    });
  }
}

function shutdownRpcAndExit(exitCode = 0) {
  for (const client of clients) {
    try {
      client.close();
    } catch {
      // noop
    }
  }

  wss.close();

  rpc.close();
  process.exit(exitCode);
}

void connectRpc();

process.on('SIGINT', () => {
  clearStaleActivityTimer();
  shutdownRpcAndExit(0);
});

process.on('SIGTERM', () => {
  clearStaleActivityTimer();
  shutdownRpcAndExit(0);
});
