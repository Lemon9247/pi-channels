import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { encode, FrameDecoder } from "./framing.js";
import { type Message } from "./message.js";

export interface ChannelOptions {
    /** Path to the Unix domain socket file. */
    path: string;
    /** Identity name announced on connect. */
    name: string;
    /** Whether to echo messages back to sender. Default: false. */
    echoToSender?: boolean;
}

interface ConnectedClient {
    id: string;
    socket: net.Socket;
    decoder: FrameDecoder;
}

class ChannelServer extends EventEmitter {
    private static readonly MAX_QUEUE_SIZE = 1000;

    private readonly socketPath: string;
    private readonly echoToSender: boolean;
    private server: net.Server | null = null;
    private clients: Map<string, ConnectedClient> = new Map();
    private started = false;
    private nextClientId = 0;
    private messageQueue: Buffer[] = [];

    constructor(socketPath: string, echoToSender: boolean) {
        super();
        this.socketPath = socketPath;
        this.echoToSender = echoToSender;
    }

    async start(): Promise<void> {
        if (this.started) {
            throw new Error("Channel server already started");
        }

        await this.cleanStaleSocket();
        fs.mkdirSync(path.dirname(this.socketPath), { recursive: true });

        return new Promise<void>((resolve, reject) => {
            const server = net.createServer((socket) => {
                this.handleConnection(socket);
            });

            const onStartError = (err: Error) => reject(err);
            server.once("error", onStartError);

            server.listen(this.socketPath, () => {
                server.removeListener("error", onStartError);
                server.on("error", (err) => this.emit("error", err));
                this.server = server;
                this.started = true;
                resolve();
            });
        });
    }

    async stop(): Promise<void> {
        if (!this.started) return;
        this.started = false;

        for (const client of this.clients.values()) {
            client.socket.destroy();
        }
        this.clients.clear();

        return new Promise<void>((resolve) => {
            if (!this.server) {
                this.unlinkSocket();
                resolve();
                return;
            }

            this.server.close(() => {
                this.server = null;
                this.unlinkSocket();
                resolve();
            });
        });
    }

    broadcast(msg: Message): void {
        const frame = encode(msg);
        if (this.clients.size === 0) {
            this.enqueue(frame);
            return;
        }

        const clients = Array.from(this.clients.values());
        for (const client of clients) {
            this.writeToClient(client, frame);
        }
    }

    get path(): string {
        return this.socketPath;
    }

    private enqueue(frame: Buffer): void {
        if (this.messageQueue.length >= ChannelServer.MAX_QUEUE_SIZE) {
            this.messageQueue.shift();
        }
        this.messageQueue.push(frame);
    }

    private handleConnection(socket: net.Socket): void {
        const clientId = `client-${this.nextClientId++}`;
        const client: ConnectedClient = {
            id: clientId,
            socket,
            decoder: new FrameDecoder(),
        };

        this.clients.set(clientId, client);
        this.emit("connect", clientId);

        if (this.messageQueue.length > 0) {
            for (const frame of this.messageQueue) {
                this.writeToClient(client, frame);
            }
            this.messageQueue = [];
        }

        socket.on("data", (chunk: Buffer) => {
            let messages: Message[];
            try {
                messages = client.decoder.push(chunk);
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
            if ((err as NodeJS.ErrnoException).code !== "ECONNRESET") {
                this.emit("error", err);
            }
            this.disconnectClient(clientId);
        });
    }

    private fanOut(msg: Message, senderId: string): void {
        const frame = encode(msg);
        const recipients = Array.from(this.clients.values()).filter(
            (client) => this.echoToSender || client.id !== senderId,
        );

        if (recipients.length === 0) {
            this.enqueue(frame);
            return;
        }

        for (const client of recipients) {
            this.writeToClient(client, frame);
        }
    }

    private writeToClient(client: ConnectedClient, frame: Buffer): void {
        try {
            if (!client.socket.destroyed) {
                client.socket.write(frame);
            }
        } catch {
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
                testSocket.destroy();
                reject(new Error(`Socket already in use: ${this.socketPath}`));
            });

            testSocket.on("error", (err) => {
                clearTimeout(timeout);
                const code = (err as NodeJS.ErrnoException).code;
                if (code === "ECONNREFUSED" || code === "ENOTSOCK") {
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
            // Best effort.
        }
    }
}

class ChannelClientConn extends EventEmitter {
    private readonly socketPath: string;
    private socket: net.Socket | null = null;
    private decoder = new FrameDecoder();
    private connected = false;
    private stopping = false;

    constructor(socketPath: string) {
        super();
        this.socketPath = socketPath;
    }

    async connect(): Promise<void> {
        if (this.connected) {
            throw new Error("Already connected");
        }
        this.stopping = false;

        return new Promise<void>((resolve, reject) => {
            const socket = net.connect(this.socketPath);

            socket.on("connect", () => {
                this.socket = socket;
                this.connected = true;
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
                const wasConnected = this.connected;
                this.connected = false;
                this.socket = null;
                this.decoder.reset();
                if (wasConnected && !this.stopping) {
                    this.emit("disconnect");
                }
            });

            socket.on("error", (err) => {
                if (!this.connected) {
                    reject(err);
                } else if ((err as NodeJS.ErrnoException).code !== "ECONNRESET") {
                    this.emit("error", err);
                }
            });
        });
    }

    disconnect(): void {
        this.stopping = true;
        if (this.socket) {
            this.socket.removeAllListeners();
            if (!this.socket.destroyed) {
                this.socket.destroy();
            }
        }
        this.connected = false;
        this.socket = null;
        this.decoder.reset();
    }

    send(msg: Message): void {
        if (!this.connected || !this.socket || this.socket.destroyed) {
            throw new Error("Not connected");
        }
        this.socket.write(encode(msg));
    }
}

interface MemberInfo {
    clientId: string;
    name: string;
}

/**
 * A Channel is a named shared pub/sub group over a Unix socket.
 *
 * On join it tries to become the server first; if the socket already exists,
 * it connects as a client instead. If the server dies, clients race to promote.
 */
export class Channel extends EventEmitter {
    private readonly socketPath: string;
    private readonly _name: string;
    private readonly echoToSender: boolean;

    private server: ChannelServer | null = null;
    private client: ChannelClientConn | null = null;
    private _role: "server" | "client" | null = null;
    private _joined = false;
    private stopping = false;

    private memberMap: Map<string, MemberInfo> = new Map();
    private knownMembers: Set<string> = new Set();

    constructor(options: ChannelOptions) {
        super();
        this.socketPath = options.path;
        this._name = options.name;
        this.echoToSender = options.echoToSender ?? false;
    }

    async join(): Promise<void> {
        if (this._joined) return;
        this.stopping = false;

        try {
            await this.startAsServer();
        } catch {
            await this.startAsClient();
        }

        this._joined = true;
    }

    async leave(): Promise<void> {
        if (!this._joined) return;
        this.stopping = true;
        this._joined = false;

        if (this._role === "server" && this.server) {
            this.server.broadcast({
                msg: `${this._name} left`,
                data: { type: "system", event: "leave", name: this._name },
            });
            await this.server.stop();
            this.server = null;
            this.memberMap.clear();
        } else if (this._role === "client" && this.client) {
            try {
                this.client.send({
                    msg: `${this._name} left`,
                    data: { type: "system", event: "leave", name: this._name },
                });
            } catch {
                // Already gone.
            }
            this.client.disconnect();
            this.client = null;
            this.knownMembers.clear();
        }

        this._role = null;
    }

    send(msg: Message): void {
        if (!this._joined) {
            throw new Error("Not joined");
        }

        const enriched: Message = {
            msg: msg.msg,
            data: { from: this._name, ...msg.data },
        };

        if (this._role === "server" && this.server) {
            this.server.broadcast(enriched);
            this.emit("message", enriched, (enriched.data?.from as string) ?? this._name);
            return;
        }

        if (this._role === "client" && this.client) {
            this.client.send(enriched);
            if (!this.echoToSender) {
                this.emit("message", enriched, (enriched.data?.from as string) ?? this._name);
            }
            return;
        }

        throw new Error("Channel is not connected");
    }

    get members(): string[] {
        if (this._role === "server") {
            return [this._name, ...Array.from(this.memberMap.values()).map((member) => member.name)];
        }
        return [this._name, ...Array.from(this.knownMembers)];
    }

    get role(): "server" | "client" | null {
        return this._role;
    }

    get joined(): boolean {
        return this._joined;
    }

    get name(): string {
        return this._name;
    }

    get path(): string {
        return this.socketPath;
    }

    private async startAsServer(): Promise<void> {
        const server = new ChannelServer(this.socketPath, this.echoToSender);
        await server.start();

        this.server = server;
        this._role = "server";
        this.emit("role", "server");

        server.on("message", (msg: Message, clientId: string) => {
            if (msg.data?.type === "system" && msg.data?.event === "identify") {
                const name = String(msg.data.name ?? "unknown");
                this.memberMap.set(clientId, { clientId, name });
                server.broadcast({
                    msg: `${name} joined`,
                    data: { type: "system", event: "join", name },
                });
                this.emit("join", name);
                server.broadcast({
                    msg: "member_list",
                    data: {
                        type: "system",
                        event: "member_list",
                        members: this.members,
                    },
                });
                return;
            }

            if (msg.data?.type === "system" && msg.data?.event === "leave") {
                const name = String(msg.data.name ?? "unknown");
                this.memberMap.delete(clientId);
                this.emit("leave", name);
                return;
            }

            const from = String(msg.data?.from ?? "unknown");
            this.emit("message", msg, from);
        });

        server.on("disconnect", (clientId: string) => {
            const member = this.memberMap.get(clientId);
            if (!member) return;

            this.memberMap.delete(clientId);
            server.broadcast({
                msg: `${member.name} left`,
                data: { type: "system", event: "leave", name: member.name },
            });
            this.emit("leave", member.name);
        });

        server.on("error", (err: Error) => {
            this.emit("error", err);
        });
    }

    private async startAsClient(): Promise<void> {
        const client = new ChannelClientConn(this.socketPath);
        await client.connect();

        this.client = client;
        this._role = "client";
        this.emit("role", "client");

        client.send({
            msg: `${this._name} identifying`,
            data: { type: "system", event: "identify", name: this._name },
        });

        client.on("message", (msg: Message) => {
            if (msg.data?.type === "system") {
                const event = String(msg.data.event ?? "");
                if (event === "join") {
                    const name = String(msg.data.name ?? "unknown");
                    if (name !== this._name) {
                        this.knownMembers.add(name);
                        this.emit("join", name);
                    }
                } else if (event === "leave") {
                    const name = String(msg.data.name ?? "unknown");
                    if (name !== this._name) {
                        this.knownMembers.delete(name);
                        this.emit("leave", name);
                    }
                } else if (event === "member_list") {
                    const members = Array.isArray(msg.data.members) ? msg.data.members : [];
                    this.knownMembers.clear();
                    for (const member of members) {
                        if (member !== this._name && typeof member === "string") {
                            this.knownMembers.add(member);
                        }
                    }
                }
                return;
            }

            const from = String(msg.data?.from ?? "unknown");
            if (from !== this._name || this.echoToSender) {
                this.emit("message", msg, from);
            }
        });

        client.on("disconnect", () => {
            if (this.stopping || !this._joined) return;
            void this.attemptPromotion();
        });

        client.on("error", (err: Error) => {
            this.emit("error", err);
        });
    }

    private async attemptPromotion(): Promise<void> {
        if (this.stopping || !this._joined) return;

        if (this.client) {
            this.client.disconnect();
            this.client = null;
        }
        this.knownMembers.clear();
        this._role = null;

        await wait(50 + Math.random() * 250);
        if (this.stopping || !this._joined) return;

        try {
            await this.startAsServer();
            return;
        } catch {
            for (let attempt = 0; attempt < 5; attempt++) {
                if (this.stopping || !this._joined) return;
                await wait(100 + Math.random() * 200);
                try {
                    await this.startAsClient();
                    return;
                } catch {
                    // Keep trying.
                }
            }
        }

        this._joined = false;
        this.emit("error", new Error("Failed to reconnect after server death"));
    }
}

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
