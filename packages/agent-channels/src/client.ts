import { EventEmitter } from "node:events";
import * as net from "node:net";
import { type Message } from "./message.js";
import { encode, FrameDecoder } from "./framing.js";

export interface ChannelClientOptions {
    /** Automatically reconnect on disconnect with jittered exponential backoff. Default: false. */
    autoReconnect?: boolean;
    /** Initial reconnect delay in ms. Default: 250. */
    reconnectDelay?: number;
    /** Maximum reconnect delay in ms. Default: 10000. */
    maxReconnectDelay?: number;
    /** Maximum reconnect attempts. 0 = unlimited. Default: 0. */
    maxReconnectAttempts?: number;
}

/**
 * A ChannelClient connects to a Channel (Unix domain socket server)
 * to send and receive messages.
 *
 * Events:
 * - "message" (msg: Message) — received a message from the channel
 * - "connect" — connected successfully
 * - "disconnect" — connection lost or closed
 * - "reconnect" — reconnected successfully after a disconnect
 * - "reconnect_failed" — max reconnect attempts reached
 * - "error" (err: Error) — connection or protocol error
 */
export class ChannelClient extends EventEmitter {
    private readonly socketPath: string;
    private readonly autoReconnect: boolean;
    private readonly initialReconnectDelay: number;
    private readonly maxReconnectDelay: number;
    private readonly maxReconnectAttempts: number;
    private socket: net.Socket | null = null;
    private decoder: FrameDecoder = new FrameDecoder();
    private _connected = false;
    private reconnectAttempt = 0;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private stopping = false;

    constructor(path: string, options?: ChannelClientOptions) {
        super();
        this.socketPath = path;
        this.autoReconnect = options?.autoReconnect ?? false;
        this.initialReconnectDelay = options?.reconnectDelay ?? 250;
        this.maxReconnectDelay = options?.maxReconnectDelay ?? 10000;
        this.maxReconnectAttempts = options?.maxReconnectAttempts ?? 0;
    }

    /** Connect to the channel. */
    async connect(): Promise<void> {
        if (this._connected) {
            throw new Error("Already connected");
        }

        return new Promise<void>((resolve, reject) => {
            const socket = net.connect(this.socketPath);

            socket.on("connect", () => {
                this.socket = socket;
                this._connected = true;
                this.emit("connect");
                resolve();
            });

            socket.on("data", (chunk: Buffer) => {
                let messages: Message[];
                try {
                    messages = this.decoder.push(chunk);
                } catch (err) {
                    this.emit("error", err instanceof Error ? err : new Error(String(err)));
                    this.disconnect();
                    return;
                }

                for (const msg of messages) {
                    this.emit("message", msg);
                }
            });

            socket.on("close", () => {
                const wasConnected = this._connected;
                this._connected = false;
                this.socket = null;
                this.decoder.reset();
                if (wasConnected) {
                    this.emit("disconnect");
                    if (this.autoReconnect && !this.stopping) {
                        this.scheduleReconnect();
                    }
                }
            });

            socket.on("error", (err) => {
                if (!this._connected) {
                    reject(err);
                } else {
                    this.emit("error", err);
                }
            });
        });
    }

    /** Disconnect from the channel. */
    disconnect(): void {
        this.stopping = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.socket) {
            this.socket.removeAllListeners();
            if (!this.socket.destroyed) {
                this.socket.destroy();
            }
        }
        this._connected = false;
        this.socket = null;
        this.decoder.reset();
        this.reconnectAttempt = 0;
    }

    /** Send a message to the channel. */
    send(msg: Message): void {
        if (!this._connected || !this.socket || this.socket.destroyed) {
            throw new Error("Not connected");
        }
        this.socket.write(encode(msg));
    }

    /** Whether currently connected. */
    get connected(): boolean {
        return this._connected;
    }

    /** The socket path this client connects to. */
    get path(): string {
        return this.socketPath;
    }

    private scheduleReconnect(): void {
        if (this.stopping) return;
        if (this.maxReconnectAttempts > 0 && this.reconnectAttempt >= this.maxReconnectAttempts) {
            this.emit("reconnect_failed");
            return;
        }

        this.reconnectAttempt++;
        const base = this.initialReconnectDelay * Math.pow(2, this.reconnectAttempt - 1);
        const jitter = base * (0.75 + Math.random() * 0.5);
        const delay = Math.min(Math.round(jitter), this.maxReconnectDelay);

        this.reconnectTimer = setTimeout(async () => {
            this.reconnectTimer = null;
            if (this.stopping) return;

            try {
                await this.connect();
                this.reconnectAttempt = 0;
                this.emit("reconnect");
            } catch {
                this.scheduleReconnect();
            }
        }, delay);
    }
}
