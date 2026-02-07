import { EventEmitter } from "node:events";
import * as net from "node:net";
import { type Message } from "./message.js";
import { encode, FrameDecoder } from "./framing.js";

/**
 * A ChannelClient connects to a Channel (Unix domain socket server)
 * to send and receive messages.
 *
 * Events:
 * - "message" (msg: Message) — received a message from the channel
 * - "connect" — connected successfully
 * - "disconnect" — connection lost or closed
 * - "error" (err: Error) — connection or protocol error
 */
export class ChannelClient extends EventEmitter {
    private readonly socketPath: string;
    private socket: net.Socket | null = null;
    private decoder: FrameDecoder = new FrameDecoder();
    private _connected = false;

    constructor(path: string) {
        super();
        this.socketPath = path;
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
        if (this.socket && !this.socket.destroyed) {
            this.socket.destroy();
        }
        this._connected = false;
        this.socket = null;
        this.decoder.reset();
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
}
