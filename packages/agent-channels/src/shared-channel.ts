import { EventEmitter } from "node:events";
import { Channel } from "./channel.js";
import { ChannelClient } from "./client.js";
import { type Message } from "./message.js";
import { encode } from "./framing.js";

export interface SharedChannelOptions {
    /** Identity name announced on connect. */
    name: string;
    /** Number of recent messages to buffer when in server mode. Default: 0. */
    historySize?: number;
    /** Whether to echo messages back to sender. Default: false. */
    echoToSender?: boolean;
}

interface MemberInfo {
    clientId: string;
    name: string;
}

/**
 * A SharedChannel is a transparent server-or-client with automatic failover.
 *
 * The caller never knows or cares which role they're in. On `join()`, it
 * tries to bind as server first; if the socket is already in use, it falls
 * back to connecting as a client.
 *
 * When the server dies, clients detect the disconnect and race to promote —
 * the first to bind wins, the rest reconnect as clients.
 *
 * Events:
 * - "message" (msg: Message, from: string) — received a message
 * - "join" (name: string) — a member joined
 * - "leave" (name: string) — a member left
 * - "role" (role: "server" | "client") — role changed (promotion/demotion)
 * - "error" (err: Error) — error
 */
export class SharedChannel extends EventEmitter {
    private readonly socketPath: string;
    private readonly _name: string;
    private readonly historySize: number;
    private readonly echoToSender: boolean;

    private channel: Channel | null = null;
    private client: ChannelClient | null = null;
    private _role: "server" | "client" | null = null;
    private _joined = false;
    private stopping = false;

    // Server-mode member tracking: clientId → name
    private memberMap: Map<string, MemberInfo> = new Map();
    // Client-mode: known members (from system messages)
    private knownMembers: Set<string> = new Set();

    constructor(path: string, options: SharedChannelOptions) {
        super();
        this.socketPath = path;
        this._name = options.name;
        this.historySize = options.historySize ?? 0;
        this.echoToSender = options.echoToSender ?? false;
    }

    /** Try to join: bind as server, fallback to client. */
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

    /** Leave the shared channel. */
    async leave(): Promise<void> {
        if (!this._joined) return;
        this.stopping = true;
        this._joined = false;

        if (this._role === "server" && this.channel) {
            // Broadcast leave before stopping
            this.channel.broadcast({
                msg: `${this._name} left`,
                data: { type: "system", event: "leave", name: this._name },
            });
            await this.channel.stop();
            this.channel = null;
            this.memberMap.clear();
        } else if (this._role === "client" && this.client) {
            try {
                this.client.send({
                    msg: `${this._name} left`,
                    data: { type: "system", event: "leave", name: this._name },
                });
            } catch {
                // Already disconnected
            }
            this.client.disconnect();
            this.client = null;
            this.knownMembers.clear();
        }

        this._role = null;
    }

    /** Send a message to the channel. */
    send(msg: Message): void {
        if (!this._joined) throw new Error("Not joined");

        // Attach sender info
        const enriched: Message = {
            msg: msg.msg,
            data: { ...msg.data, from: this._name },
        };

        if (this._role === "server" && this.channel) {
            // Broadcast to all clients
            this.channel.broadcast(enriched);
            // Also emit locally (server doesn't receive its own broadcasts)
            this.emit("message", enriched, this._name);
        } else if (this._role === "client" && this.client) {
            this.client.send(enriched);
            // We'll get it back via echo if echoToSender, otherwise emit locally
            if (!this.echoToSender) {
                this.emit("message", enriched, this._name);
            }
        }
    }

    /** Current members (names). */
    get members(): string[] {
        if (this._role === "server") {
            const names = Array.from(this.memberMap.values()).map((m) => m.name);
            return [this._name, ...names];
        } else {
            return [this._name, ...Array.from(this.knownMembers)];
        }
    }

    /** Current role. */
    get role(): "server" | "client" | null {
        return this._role;
    }

    /** Whether currently joined. */
    get joined(): boolean {
        return this._joined;
    }

    /** This member's name. */
    get name(): string {
        return this._name;
    }

    /** The socket path. */
    get path(): string {
        return this.socketPath;
    }

    // ─── Server Mode ────────────────────────────────────────────────

    private async startAsServer(): Promise<void> {
        const channel = new Channel({
            path: this.socketPath,
            echoToSender: this.echoToSender,
            historySize: this.historySize,
        });

        await channel.start();
        this.channel = channel;
        this._role = "server";
        this.emit("role", "server");

        channel.on("message", (msg: Message, clientId: string) => {
            // Handle identify messages
            if (msg.data?.type === "system" && msg.data?.event === "identify") {
                const name = msg.data.name as string;
                this.memberMap.set(clientId, { clientId, name });
                // Broadcast join notification to all
                const joinMsg: Message = {
                    msg: `${name} joined`,
                    data: { type: "system", event: "join", name },
                };
                channel.broadcast(joinMsg);
                this.emit("join", name);

                // Send current member list to newly joined client
                const memberList = this.members;
                const membersMsg: Message = {
                    msg: "member_list",
                    data: { type: "system", event: "member_list", members: memberList },
                };
                // Send only to the new client - find its socket
                // We broadcast it; clients filter by event type
                channel.broadcast(membersMsg);
                return;
            }

            // Handle leave messages
            if (msg.data?.type === "system" && msg.data?.event === "leave") {
                const name = msg.data.name as string;
                this.memberMap.delete(clientId);
                this.emit("leave", name);
                return;
            }

            // Regular message — emit it
            const from = (msg.data?.from as string) ?? "unknown";
            this.emit("message", msg, from);
        });

        channel.on("disconnect", (clientId: string) => {
            const member = this.memberMap.get(clientId);
            if (member) {
                this.memberMap.delete(clientId);
                // Broadcast leave notification
                const leaveMsg: Message = {
                    msg: `${member.name} left`,
                    data: { type: "system", event: "leave", name: member.name },
                };
                channel.broadcast(leaveMsg);
                this.emit("leave", member.name);
            }
        });

        channel.on("error", (err: Error) => {
            this.emit("error", err);
        });
    }

    // ─── Client Mode ────────────────────────────────────────────────

    private async startAsClient(): Promise<void> {
        const client = new ChannelClient(this.socketPath, {
            autoReconnect: false, // We handle reconnection ourselves for promotion
        });

        await client.connect();
        this.client = client;
        this._role = "client";
        this.emit("role", "client");

        // Identify ourselves
        client.send({
            msg: `${this._name} identifying`,
            data: { type: "system", event: "identify", name: this._name },
        });

        client.on("message", (msg: Message) => {
            // Handle system messages
            if (msg.data?.type === "system") {
                const event = msg.data.event as string;

                if (event === "join") {
                    const name = msg.data.name as string;
                    if (name !== this._name) {
                        this.knownMembers.add(name);
                        this.emit("join", name);
                    }
                } else if (event === "leave") {
                    const name = msg.data.name as string;
                    if (name !== this._name) {
                        this.knownMembers.delete(name);
                        this.emit("leave", name);
                    }
                } else if (event === "member_list") {
                    const members = msg.data.members as string[];
                    this.knownMembers.clear();
                    for (const name of members) {
                        if (name !== this._name) {
                            this.knownMembers.add(name);
                        }
                    }
                }
                return;
            }

            // Regular message
            const from = (msg.data?.from as string) ?? "unknown";
            if (from !== this._name) {
                this.emit("message", msg, from);
            }
        });

        client.on("disconnect", () => {
            if (this.stopping || !this._joined) return;
            // Server died — attempt promotion
            this.attemptPromotion();
        });

        client.on("error", (err: Error) => {
            this.emit("error", err);
        });
    }

    private async attemptPromotion(): Promise<void> {
        if (this.stopping || !this._joined) return;

        // Clean up old client
        if (this.client) {
            this.client.disconnect();
            this.client = null;
        }
        this.knownMembers.clear();
        this._role = null;

        // Random jitter before attempting promotion (50-300ms)
        const jitter = 50 + Math.random() * 250;
        await new Promise((r) => setTimeout(r, jitter));

        if (this.stopping || !this._joined) return;

        try {
            await this.startAsServer();
        } catch {
            // Someone else won the race — connect as client
            // Retry with backoff
            for (let attempt = 0; attempt < 5; attempt++) {
                if (this.stopping || !this._joined) return;
                const delay = 100 + Math.random() * 200;
                await new Promise((r) => setTimeout(r, delay));
                try {
                    await this.startAsClient();
                    return;
                } catch {
                    // Keep trying
                }
            }
            // Give up
            this._joined = false;
            this.emit("error", new Error("Failed to reconnect after server death"));
        }
    }
}
