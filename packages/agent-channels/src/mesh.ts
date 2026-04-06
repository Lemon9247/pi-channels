import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { SharedChannel } from "./shared-channel.js";
import { Channel } from "./channel.js";
import { ChannelClient } from "./client.js";
import { type Message } from "./message.js";

export interface MeshOptions {
    /** This agent's name. */
    name: string;
    /** Directory for socket files. Created if it doesn't exist. */
    dir: string;
    /** History size for SharedChannels. Default: 100. */
    historySize?: number;
}

export interface MessageMeta {
    /** Which channel or "dm". */
    channel: string;
    /** Sender name. */
    from: string;
}

/**
 * High-level API that manages multiple SharedChannels (topic channels)
 * + a Channel (DM inbox) + ephemeral ChannelClient (DM sending).
 *
 * Works like Discord/IRC — agents dynamically join and leave named channels.
 *
 * Events:
 * - "message" (msg: Message, meta: MessageMeta) — received a message
 * - "join" (name: string, channel: string) — a member joined a channel
 * - "leave" (name: string, channel: string) — a member left a channel
 * - "error" (err: Error) — error
 */
export class Mesh extends EventEmitter {
    private readonly _name: string;
    private readonly dir: string;
    private readonly historySize: number;

    private sharedChannels: Map<string, SharedChannel> = new Map();
    private inbox: Channel | null = null;
    private _joined = false;

    constructor(options: MeshOptions) {
        super();
        this._name = options.name;
        this.dir = options.dir;
        this.historySize = options.historySize ?? 100;
    }

    /**
     * Join the mesh. Creates the socket directory, joins "general",
     * and creates the DM inbox.
     *
     * Optionally pass a channel name to join a specific topic channel
     * instead of doing the initial setup.
     */
    async join(channel?: string): Promise<void> {
        // If not yet initialized, do full setup
        if (!this._joined && !channel) {
            fs.mkdirSync(this.dir, { recursive: true });

            // Join general channel
            await this.joinChannel("general");

            // Create DM inbox
            await this.startInbox();

            this._joined = true;
            return;
        }

        // If already joined and a channel name given, join that channel
        if (channel) {
            if (!this._joined) {
                // Auto-initialize first
                await this.join();
            }
            await this.joinChannel(channel);
            return;
        }

        // Already joined, no channel specified — no-op
    }

    /**
     * Leave a channel, or leave everything if no channel specified.
     */
    async leave(channel?: string): Promise<void> {
        if (channel) {
            const sc = this.sharedChannels.get(channel);
            if (sc) {
                await sc.leave();
                this.sharedChannels.delete(channel);
                // Clean up socket if no members left and we were server
                this.cleanupSocketIfEmpty(channel);
            }
            return;
        }

        // Leave everything
        this._joined = false;

        // Leave all shared channels
        const leavePromises: Promise<void>[] = [];
        for (const [name, sc] of this.sharedChannels) {
            leavePromises.push(
                sc.leave().then(() => {
                    this.cleanupSocketIfEmpty(name);
                }),
            );
        }
        await Promise.all(leavePromises);
        this.sharedChannels.clear();

        // Close inbox
        if (this.inbox) {
            await this.inbox.stop();
            this.inbox = null;
        }
    }

    /**
     * Send a message to a channel (default: general).
     */
    send(message: string, options?: { channel?: string }): void {
        return this.sendAs(this._name, message, options);
    }

    /**
     * Send a message as a specific sender (for human messages from overlay).
     */
    sendAs(sender: string, message: string, options?: { channel?: string }): void {
        const channelName = options?.channel ?? "general";
        const sc = this.sharedChannels.get(channelName);
        if (!sc) {
            throw new Error(`Not in channel "${channelName}"`);
        }
        sc.send({
            msg: message,
            data: { type: "chat", from: sender, channel: channelName },
        });
    }

    /**
     * Send a DM to a specific agent via their inbox socket.
     */
    async sendTo(target: string, message: string): Promise<void> {
        return this.sendToAs(this._name, target, message);
    }

    /**
     * Send a DM as a specific sender.
     */
    async sendToAs(sender: string, target: string, message: string): Promise<void> {
        const inboxPath = path.join(this.dir, `inbox-${target}.sock`);
        const client = new ChannelClient(inboxPath);
        try {
            await client.connect();
            client.send({
                msg: message,
                data: { type: "dm", from: sender, to: target },
            });
            // Small delay to ensure message is sent before disconnect
            await new Promise((r) => setTimeout(r, 50));
            client.disconnect();
        } catch {
            throw new Error(`Cannot reach ${target} — they may be offline`);
        }
    }

    /** List of channel names we're in. */
    get channels(): string[] {
        return Array.from(this.sharedChannels.keys());
    }

    /** All members across all channels (deduplicated). */
    allMembers(): string[] {
        const all = new Set<string>();
        for (const sc of this.sharedChannels.values()) {
            for (const m of sc.members) {
                all.add(m);
            }
        }
        return Array.from(all);
    }

    /**
     * Members in a specific channel.
     */
    channelMembers(channel: string): string[] {
        const sc = this.sharedChannels.get(channel);
        if (!sc) return [];
        return sc.members;
    }

    /** This agent's name. */
    get name(): string {
        return this._name;
    }

    /** Whether the mesh is joined. */
    get joined(): boolean {
        return this._joined;
    }

    /** The socket directory path. */
    get socketDir(): string {
        return this.dir;
    }

    // ─── Internal ───────────────────────────────────────────────────

    private async joinChannel(channelName: string): Promise<void> {
        if (this.sharedChannels.has(channelName)) return;

        const socketPath = path.join(this.dir, `${channelName}.sock`);
        const sc = new SharedChannel(socketPath, {
            name: this._name,
            historySize: this.historySize,
            echoToSender: false,
        });

        sc.on("message", (msg: Message, from: string) => {
            // Don't re-emit system messages as regular messages
            if (msg.data?.type === "system") return;
            const meta: MessageMeta = {
                channel: channelName,
                from,
            };
            this.emit("message", msg, meta);
        });

        sc.on("join", (name: string) => {
            this.emit("join", name, channelName);
        });

        sc.on("leave", (name: string) => {
            this.emit("leave", name, channelName);
        });

        sc.on("error", (err: Error) => {
            this.emit("error", err);
        });

        await sc.join();
        this.sharedChannels.set(channelName, sc);
    }

    private async startInbox(): Promise<void> {
        const inboxPath = path.join(this.dir, `inbox-${this._name}.sock`);
        const inbox = new Channel({
            path: inboxPath,
            historySize: 0,
        });

        await inbox.start();
        this.inbox = inbox;

        inbox.on("message", (msg: Message) => {
            const from = (msg.data?.from as string) ?? "unknown";
            const meta: MessageMeta = {
                channel: "dm",
                from,
            };
            this.emit("message", msg, meta);
        });

        inbox.on("error", (err: Error) => {
            this.emit("error", err);
        });
    }

    private cleanupSocketIfEmpty(channelName: string): void {
        const socketPath = path.join(this.dir, `${channelName}.sock`);
        // Best-effort cleanup — if the file exists and we were the last member
        try {
            if (fs.existsSync(socketPath)) {
                // Don't remove if another process might be using it
                // Only remove if we can confirm no one is listening
                // Actually, the Channel.stop() already removes the socket
                // This is just for leftover cases
            }
        } catch {
            // Ignore
        }
    }
}
