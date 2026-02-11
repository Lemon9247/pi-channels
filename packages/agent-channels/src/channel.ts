import { EventEmitter } from "node:events";
import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import { type Message } from "./message.js";
import { encode, FrameDecoder } from "./framing.js";

export interface ChannelOptions {
    /** Path to the Unix domain socket file. */
    path: string;
    /** Whether to echo messages back to the sender. Default: false. */
    echoToSender?: boolean;
}

interface ConnectedClient {
    id: string;
    socket: net.Socket;
    decoder: FrameDecoder;
}

/**
 * A Channel is a Unix domain socket server that fans out messages
 * to all connected clients.
 *
 * When any client sends a message, every other connected client receives
 * it (sender excluded by default, configurable with `echoToSender`).
 *
 * Events:
 * - "message" (msg: Message, clientId: string) — a client sent a message
 * - "connect" (clientId: string) — a client connected
 * - "disconnect" (clientId: string) — a client disconnected
 * - "error" (err: Error) — server or client error
 */
export class Channel extends EventEmitter {
    private readonly socketPath: string;
    private readonly echoToSender: boolean;
    private server: net.Server | null = null;
    private clients: Map<string, ConnectedClient> = new Map();
    private _started = false;
    private nextClientId = 0;

    constructor(options: ChannelOptions) {
        super();
        this.socketPath = options.path;
        this.echoToSender = options.echoToSender ?? false;
    }

    /** Start listening on the Unix domain socket. */
    async start(): Promise<void> {
        if (this._started) {
            throw new Error("Channel already started");
        }

        // Handle stale sockets from crashed processes
        await this.cleanStaleSocket();

        // Ensure parent directory exists
        const dir = path.dirname(this.socketPath);
        fs.mkdirSync(dir, { recursive: true });

        return new Promise<void>((resolve, reject) => {
            const server = net.createServer((socket) => {
                this.handleConnection(socket);
            });

            const onStartError = (err: Error) => {
                reject(err);
            };

            server.once("error", onStartError);

            server.listen(this.socketPath, () => {
                server.removeListener("error", onStartError);
                server.on("error", (err) => this.emit("error", err));
                this._started = true;
                this.server = server;
                resolve();
            });
        });
    }

    /** Stop the channel, disconnect all clients, clean up socket file. */
    async stop(): Promise<void> {
        if (!this._started) return;

        this._started = false;

        // Disconnect all clients
        for (const client of this.clients.values()) {
            client.socket.destroy();
        }
        this.clients.clear();

        // Close the server
        return new Promise<void>((resolve) => {
            if (this.server) {
                this.server.close(() => {
                    this.unlinkSocket();
                    this.server = null;
                    resolve();
                });
            } else {
                resolve();
            }
        });
    }

    /** Number of connected clients. */
    get clientCount(): number {
        return this.clients.size;
    }

    /** Whether the channel is currently running. */
    get started(): boolean {
        return this._started;
    }

    /** The socket path this channel listens on. */
    get path(): string {
        return this.socketPath;
    }

    /**
     * Inject a message from the server side (broadcast to all clients).
     * No sender to exclude — everyone receives it.
     */
    broadcast(msg: Message): void {
        const frame = encode(msg);
        for (const client of this.clients.values()) {
            this.writeToClient(client, frame);
        }
    }

    private handleConnection(socket: net.Socket): void {
        const clientId = `client-${this.nextClientId++}`;
        const decoder = new FrameDecoder();
        const client: ConnectedClient = { id: clientId, socket, decoder };

        this.clients.set(clientId, client);
        this.emit("connect", clientId);

        socket.on("data", (chunk: Buffer) => {
            let messages: Message[];
            try {
                messages = decoder.push(chunk);
            } catch (err) {
                this.emit("error", err instanceof Error ? err : new Error(String(err)));
                this.disconnectClient(clientId);
                return;
            }

            for (const msg of messages) {
                this.emit("message", msg, clientId);
                this.fanOut(msg, clientId);
            }
        });

        socket.on("close", () => {
            this.disconnectClient(clientId);
        });

        socket.on("error", (err) => {
            // Suppress ECONNRESET — client just disconnected abruptly
            if ((err as NodeJS.ErrnoException).code !== "ECONNRESET") {
                this.emit("error", err);
            }
            this.disconnectClient(clientId);
        });
    }

    private fanOut(msg: Message, senderId: string): void {
        const frame = encode(msg);
        // Snapshot client list before iteration (W1 fix).
        // writeToClient can trigger disconnectClient which modifies the map.
        const snapshot = Array.from(this.clients.values());
        for (const client of snapshot) {
            if (!this.echoToSender && client.id === senderId) {
                continue;
            }
            this.writeToClient(client, frame);
        }
    }

    private writeToClient(client: ConnectedClient, frame: Buffer): void {
        try {
            if (!client.socket.destroyed) {
                client.socket.write(frame);
            }
        } catch {
            // Write failed (broken pipe, etc.) — disconnect the dead client
            this.disconnectClient(client.id);
        }
    }

    private disconnectClient(clientId: string): void {
        const client = this.clients.get(clientId);
        if (!client) return;

        this.clients.delete(clientId);
        if (!client.socket.destroyed) {
            client.socket.destroy();
        }
        this.emit("disconnect", clientId);
    }

    /**
     * Detect and clean stale sockets from crashed processes.
     * If socket file exists and no process is listening (ECONNREFUSED),
     * unlink it. If something is listening, throw — socket is in use.
     */
    private async cleanStaleSocket(): Promise<void> {
        if (!fs.existsSync(this.socketPath)) return;

        return new Promise<void>((resolve, reject) => {
            const testSocket = net.connect(this.socketPath);

            const timeout = setTimeout(() => {
                testSocket.destroy();
                reject(new Error(`Timeout checking stale socket: ${this.socketPath}`));
            }, 2000);

            testSocket.on("connect", () => {
                clearTimeout(timeout);
                // Something is listening — socket is in use
                testSocket.destroy();
                reject(
                    new Error(
                        `Socket already in use: ${this.socketPath}`
                    )
                );
            });

            testSocket.on("error", (err) => {
                clearTimeout(timeout);
                const code = (err as NodeJS.ErrnoException).code;
                if (code === "ECONNREFUSED" || code === "ENOTSOCK") {
                    // Stale socket — safe to remove
                    this.unlinkSocket();
                    resolve();
                } else {
                    reject(err);
                }
            });
        });
    }

    private unlinkSocket(): void {
        try {
            fs.unlinkSync(this.socketPath);
        } catch {
            // Ignore — file may already be gone
        }
    }
}
