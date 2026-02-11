import { EventEmitter } from "node:events";
import * as net from "node:net";
import { type Bridge } from "../bridge.js";
import { type Message } from "../message.js";
import { ChannelClient } from "../client.js";
import { encode, FrameDecoder } from "../framing.js";

// ─── TcpBridgeServer ────────────────────────────────────────────────

export interface TcpBridgeServerOptions {
    /** Path to the local channel Unix socket. */
    channelPath: string;
    /** TCP listen host. Default: "127.0.0.1". */
    host?: string;
    /** TCP listen port. */
    port: number;
}

interface TcpRemoteClient {
    id: string;
    socket: net.Socket;
    decoder: FrameDecoder;
}

/**
 * Expose a local channel over TCP. Remote processes connect via TCP
 * and exchange messages with the local channel.
 *
 * - Messages from the local channel are forwarded to all TCP clients.
 * - Messages from any TCP client are forwarded to the local channel.
 * - Same wire format as Unix sockets (4-byte length prefix + JSON).
 *
 * Events:
 * - "error" (err: Error) — bridge-level error
 * - "tcp-connect" (clientId: string) — a remote TCP client connected
 * - "tcp-disconnect" (clientId: string) — a remote TCP client disconnected
 */
export class TcpBridgeServer extends EventEmitter implements Bridge {
    private readonly channelPath: string;
    private readonly host: string;
    private readonly port: number;

    private channelClient: ChannelClient | null = null;
    private tcpServer: net.Server | null = null;
    private remoteClients: Map<string, TcpRemoteClient> = new Map();
    private nextClientId = 0;
    private _status: "running" | "stopped" | "error" = "stopped";

    constructor(options: TcpBridgeServerOptions) {
        super();
        this.channelPath = options.channelPath;
        this.host = options.host ?? "127.0.0.1";
        this.port = options.port;
    }

    get status(): "running" | "stopped" | "error" {
        return this._status;
    }

    async start(): Promise<void> {
        if (this._status === "running") {
            throw new Error("Bridge already running");
        }

        // Connect to the local channel
        const client = new ChannelClient(this.channelPath);
        await client.connect();
        this.channelClient = client;

        // Forward channel messages to all TCP clients
        client.on("message", (msg: Message) => {
            const frame = encode(msg);
            for (const remote of this.remoteClients.values()) {
                this.writeToRemote(remote, frame);
            }
        });

        client.on("disconnect", () => {
            this._status = "error";
            this.emit("error", new Error("Local channel disconnected"));
        });

        // Start TCP server — clean up channel client on failure (C1 fix)
        try {
            await new Promise<void>((resolve, reject) => {
                const server = net.createServer((socket) => {
                    this.handleTcpConnection(socket);
                });

                const onError = (err: Error) => reject(err);
                server.once("error", onError);

                server.listen(this.port, this.host, () => {
                    server.removeListener("error", onError);
                    server.on("error", (err) => this.emit("error", err));
                    this.tcpServer = server;
                    resolve();
                });
            });
        } catch (err) {
            this.channelClient.disconnect();
            this.channelClient = null;
            throw err;
        }

        this._status = "running";
    }

    async stop(): Promise<void> {
        // Always clean up whatever state exists (H1 fix)
        this._status = "stopped";

        // Disconnect all TCP clients
        for (const remote of this.remoteClients.values()) {
            remote.socket.destroy();
        }
        this.remoteClients.clear();

        // Close TCP server
        if (this.tcpServer) {
            await new Promise<void>((resolve) => {
                this.tcpServer!.close(() => resolve());
            });
            this.tcpServer = null;
        }

        // Disconnect from local channel
        if (this.channelClient) {
            this.channelClient.disconnect();
            this.channelClient = null;
        }
    }

    /** The address the TCP server is listening on. */
    get address(): net.AddressInfo | null {
        return this.tcpServer?.address() as net.AddressInfo | null;
    }

    private handleTcpConnection(socket: net.Socket): void {
        const clientId = `tcp-${this.nextClientId++}`;
        const decoder = new FrameDecoder();
        const remote: TcpRemoteClient = { id: clientId, socket, decoder };

        this.remoteClients.set(clientId, remote);
        this.emit("tcp-connect", clientId);

        socket.on("data", (chunk: Buffer) => {
            let messages: Message[];
            try {
                messages = decoder.push(chunk);
            } catch (err) {
                this.emit("error", err instanceof Error ? err : new Error(String(err)));
                this.disconnectRemote(clientId);
                return;
            }

            for (const msg of messages) {
                // Forward to local channel
                try {
                    this.channelClient?.send(msg);
                } catch {
                    // Channel disconnected — handled by the disconnect listener
                }

                // Fan out to other TCP clients (the channel won't echo back
                // to the bridge's own client, so we relay directly)
                const outFrame = encode(msg);
                for (const other of this.remoteClients.values()) {
                    if (other.id !== clientId) {
                        this.writeToRemote(other, outFrame);
                    }
                }
            }
        });

        socket.on("close", () => {
            this.disconnectRemote(clientId);
        });

        socket.on("error", (err) => {
            if ((err as NodeJS.ErrnoException).code !== "ECONNRESET") {
                this.emit("error", err);
            }
            this.disconnectRemote(clientId);
        });
    }

    private writeToRemote(remote: TcpRemoteClient, frame: Buffer): void {
        try {
            if (!remote.socket.destroyed) {
                remote.socket.write(frame);
            }
        } catch {
            this.disconnectRemote(remote.id);
        }
    }

    private disconnectRemote(clientId: string): void {
        const remote = this.remoteClients.get(clientId);
        if (!remote) return;

        this.remoteClients.delete(clientId);
        if (!remote.socket.destroyed) {
            remote.socket.destroy();
        }
        this.emit("tcp-disconnect", clientId);
    }
}

// ─── TcpBridgeClient ────────────────────────────────────────────────

export interface TcpBridgeClientOptions {
    /** Path to the local channel Unix socket. */
    channelPath: string;
    /** Remote TCP bridge host. */
    host: string;
    /** Remote TCP bridge port. */
    port: number;
    /** Reconnect on disconnect. Default: true. */
    reconnect?: boolean;
    /** Initial reconnect delay in ms. Default: 500. */
    reconnectDelay?: number;
    /** Max reconnect delay in ms. Default: 30000. */
    maxReconnectDelay?: number;
}

/**
 * Connect a local channel to a remote TcpBridgeServer.
 *
 * - Messages from the local channel are forwarded to the remote server.
 * - Messages from the remote server are forwarded to the local channel.
 * - Reconnects automatically on TCP disconnect (with exponential backoff + jitter).
 *
 * Events:
 * - "error" (err: Error) — bridge-level error
 * - "tcp-connect" — connected to remote TCP server
 * - "tcp-disconnect" — disconnected from remote TCP server
 * - "reconnecting" (attempt: number, delay: number) — about to reconnect
 */
export class TcpBridgeClient extends EventEmitter implements Bridge {
    private readonly channelPath: string;
    private readonly host: string;
    private readonly port: number;
    private readonly shouldReconnect: boolean;
    private readonly initialDelay: number;
    private readonly maxDelay: number;

    private channelClient: ChannelClient | null = null;
    private tcpSocket: net.Socket | null = null;
    private tcpDecoder: FrameDecoder = new FrameDecoder();
    private _status: "running" | "stopped" | "error" = "stopped";
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private reconnectAttempt = 0;
    private stopping = false;
    /** Track in-flight connectTcp() socket for cleanup on stop() (C4 fix). */
    private pendingSocket: net.Socket | null = null;

    constructor(options: TcpBridgeClientOptions) {
        super();
        this.channelPath = options.channelPath;
        this.host = options.host;
        this.port = options.port;
        this.shouldReconnect = options.reconnect ?? true;
        this.initialDelay = options.reconnectDelay ?? 500;
        this.maxDelay = options.maxReconnectDelay ?? 30000;
    }

    get status(): "running" | "stopped" | "error" {
        return this._status;
    }

    async start(): Promise<void> {
        if (this._status === "running") {
            throw new Error("Bridge already running");
        }

        this.stopping = false;

        // Connect to local channel
        const client = new ChannelClient(this.channelPath);
        await client.connect();
        this.channelClient = client;

        // Forward channel messages to TCP
        client.on("message", (msg: Message) => {
            this.sendToTcp(msg);
        });

        client.on("disconnect", () => {
            if (!this.stopping) {
                this._status = "error";
                this.emit("error", new Error("Local channel disconnected"));
            }
        });

        // Connect to remote TCP bridge — clean up channel client on failure (C1 fix)
        try {
            await this.connectTcp();
        } catch (err) {
            this.channelClient.disconnect();
            this.channelClient = null;
            throw err;
        }

        this._status = "running";
    }

    async stop(): Promise<void> {
        // Always clean up whatever state exists (H1 fix)
        this.stopping = true;
        this._status = "stopped";

        // Cancel any pending reconnect
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        // Clean up in-flight connection attempt (C4 fix)
        if (this.pendingSocket) {
            if (!this.pendingSocket.destroyed) {
                this.pendingSocket.destroy();
            }
            this.pendingSocket = null;
        }

        // Disconnect TCP
        if (this.tcpSocket) {
            this.tcpSocket.removeAllListeners();
            if (!this.tcpSocket.destroyed) {
                this.tcpSocket.destroy();
            }
            this.tcpSocket = null;
        }
        this.tcpDecoder.reset();

        // Disconnect local channel
        if (this.channelClient) {
            this.channelClient.disconnect();
            this.channelClient = null;
        }
    }

    private connectTcp(): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            let settled = false; // H2 fix: track whether promise is resolved/rejected
            const socket = net.connect(this.port, this.host);

            // Track in-flight socket so stop() can clean it up (C4 fix)
            this.pendingSocket = socket;

            socket.on("connect", () => {
                settled = true;
                this.pendingSocket = null;

                // If stop() was called while we were connecting, destroy immediately
                if (this.stopping) {
                    socket.destroy();
                    reject(new Error("Bridge stopped during connect"));
                    return;
                }

                this.tcpSocket = socket;
                this.tcpDecoder.reset();
                this.reconnectAttempt = 0;
                this.emit("tcp-connect");
                resolve();
            });

            socket.on("data", (chunk: Buffer) => {
                let messages: Message[];
                try {
                    messages = this.tcpDecoder.push(chunk);
                } catch (err) {
                    this.emit("error", err instanceof Error ? err : new Error(String(err)));
                    return;
                }

                // Forward TCP messages to local channel
                for (const msg of messages) {
                    try {
                        this.channelClient?.send(msg);
                    } catch {
                        // Channel disconnected
                    }
                }
            });

            socket.on("close", () => {
                const wasConnected = this.tcpSocket !== null; // C2 fix
                this.tcpSocket = null;
                this.pendingSocket = null;
                this.tcpDecoder.reset();

                // Only reconnect if we were previously connected (not on initial failure)
                if (wasConnected && !this.stopping) {
                    this.emit("tcp-disconnect");
                    this.scheduleReconnect();
                }
            });

            socket.on("error", (err) => {
                if (!settled) {
                    settled = true;
                    reject(err);
                } else if ((err as NodeJS.ErrnoException).code !== "ECONNRESET") {
                    this.emit("error", err);
                }
            });
        });
    }

    private scheduleReconnect(): void {
        if (!this.shouldReconnect || this.stopping) return;

        this.reconnectAttempt++;
        // Exponential backoff with ±25% jitter (M1 fix)
        const base = this.initialDelay * Math.pow(2, this.reconnectAttempt - 1);
        const jitter = base * (0.75 + Math.random() * 0.5);
        const delay = Math.min(Math.round(jitter), this.maxDelay);

        this.emit("reconnecting", this.reconnectAttempt, delay);

        this.reconnectTimer = setTimeout(async () => {
            this.reconnectTimer = null;
            if (this.stopping) return;

            try {
                await this.connectTcp();
            } catch {
                // connectTcp failed — schedule another retry
                this.scheduleReconnect();
            }
        }, delay);
    }

    private sendToTcp(msg: Message): void {
        try {
            if (this.tcpSocket && !this.tcpSocket.destroyed) {
                this.tcpSocket.write(encode(msg));
            }
        } catch {
            // TCP disconnected — reconnect will handle it
        }
    }
}
