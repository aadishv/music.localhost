import { EventEmitter } from 'node:events';
import * as net from 'node:net';

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 } as const;

function ipcPath(id: number): string {
  const { XDG_RUNTIME_DIR, TMPDIR, TMP, TEMP } = process.env;
  const prefix = (XDG_RUNTIME_DIR ?? TMPDIR ?? TMP ?? TEMP ?? '/tmp').replace(
    /\/$/,
    '',
  );
  return `${prefix}/discord-ipc-${id}`;
}

function encode(op: number, payload: unknown): Buffer {
  const json = JSON.stringify(payload);
  const len = Buffer.byteLength(json);
  const buf = Buffer.alloc(8 + len);
  buf.writeInt32LE(op, 0);
  buf.writeInt32LE(len, 4);
  buf.write(json, 8, len);
  return buf;
}

function tryConnect(id = 0): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    if (id > 9) return reject(new Error('No Discord IPC socket found'));
    const socket = net.createConnection(ipcPath(id), () => {
      socket.removeAllListeners('error');
      resolve(socket);
    });
    socket.once('error', () => resolve(tryConnect(id + 1)));
  });
}

export interface Activity {
  type?: number;
  details?: string;
  state?: string;
  startTimestamp?: number;
  endTimestamp?: number;
  largeImageKey?: string;
  largeImageText?: string;
  smallImageKey?: string;
  smallImageText?: string;
  buttons?: Array<{ label: string; url: string }>;
}

export interface DiscordUser {
  username?: string;
  discriminator?: string;
}

type ReadyPayload = {
  user?: DiscordUser;
};

export class DiscordIPC extends EventEmitter {
  public user: DiscordUser | null = null;

  private socket: net.Socket | null = null;
  private buf = Buffer.alloc(0);

  constructor(private readonly clientId: string) {
    super();
  }

  async connect(): Promise<void> {
    const socket = await tryConnect();
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.user = null;

    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('close', () => {
      this.socket = null;
      this.user = null;
      this.emit('close');
    });
    socket.on('error', (error) => this.emit('error', error));

    socket.write(encode(OP.HANDSHAKE, { v: 1, client_id: this.clientId }));

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('RPC_CONNECTION_TIMEOUT')),
        10_000,
      );
      this.once('ready', () => {
        clearTimeout(timer);
        resolve();
      });
      this.once('close', () => {
        clearTimeout(timer);
        reject(new Error('Socket closed before READY'));
      });
    });
  }

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 8) {
      const op = this.buf.readInt32LE(0);
      const len = this.buf.readInt32LE(4);
      if (this.buf.length < 8 + len) break;

      const payload = JSON.parse(this.buf.slice(8, 8 + len).toString()) as {
        cmd: string;
        evt: string | null;
        data: ReadyPayload;
      };
      this.buf = this.buf.slice(8 + len);

      if (op === OP.PING) {
        this.socket?.write(encode(OP.PONG, payload));
      } else if (op === OP.FRAME) {
        if (payload.cmd === 'DISPATCH' && payload.evt === 'READY') {
          this.user = payload.data.user ?? null;
          this.emit('ready', payload.data);
        } else {
          this.emit('message', payload);
        }
      } else if (op === OP.CLOSE) {
        this.socket?.destroy();
      }
    }
  }

  setActivity(activity: Activity): void {
    if (!this.socket) throw new Error('Not connected');

    const {
      type,
      details,
      state,
      startTimestamp,
      endTimestamp,
      largeImageKey,
      largeImageText,
      smallImageKey,
      smallImageText,
      buttons,
    } = activity;

    const wire: Record<string, unknown> = { type, details, state };

    if (startTimestamp !== undefined || endTimestamp !== undefined) {
      wire.timestamps = { start: startTimestamp, end: endTimestamp };
    }

    if (largeImageKey || largeImageText || smallImageKey || smallImageText) {
      wire.assets = {
        large_image: largeImageKey,
        large_text: largeImageText,
        small_image: smallImageKey,
        small_text: smallImageText,
      };
    }

    if (buttons?.length) wire.buttons = buttons;

    this.socket.write(
      encode(OP.FRAME, {
        cmd: 'SET_ACTIVITY',
        args: { pid: process.pid, activity: wire },
        nonce: Math.random().toString(36).slice(2),
      }),
    );
  }

  clearActivity(): void {
    if (!this.socket) throw new Error('Not connected');
    this.socket.write(
      encode(OP.FRAME, {
        cmd: 'SET_ACTIVITY',
        args: { pid: process.pid, activity: null },
        nonce: Math.random().toString(36).slice(2),
      }),
    );
  }

  close(): void {
    this.socket?.write(encode(OP.CLOSE, {}));
    this.socket?.end();
  }
}
