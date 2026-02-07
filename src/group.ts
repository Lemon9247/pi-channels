import * as fs from "node:fs";
import * as path from "node:path";
import { Channel, type ChannelOptions } from "./channel.js";

export interface GroupChannelDef {
    /** Channel name (becomes <name>.sock in the group directory). */
    name: string;
    /** Semantic hint — no behavioral difference. Stored in group.json. */
    inbox?: boolean;
    /** Channel options override (e.g. echoToSender). */
    options?: Omit<ChannelOptions, "path">;
}

export interface ChannelGroupOptions {
    /** Directory path for the group. Created if it doesn't exist. */
    path: string;
    /** Channels to create on start. */
    channels: GroupChannelDef[];
}

interface GroupMetadata {
    created: string;
    pid: number;
    channels: Array<{ name: string; inbox?: boolean }>;
}

/**
 * A ChannelGroup is a directory of channels with lifecycle management.
 *
 * Create a group with a set of named channels. The group manages:
 * - Directory creation
 * - Starting/stopping all channels
 * - group.json metadata (written after all channels are listening)
 * - Runtime channel addition
 * - Cleanup on stop
 */
export class ChannelGroup {
    private readonly groupPath: string;
    private readonly channelDefs: GroupChannelDef[];
    private channels: Map<string, Channel> = new Map();
    private _started = false;

    constructor(options: ChannelGroupOptions) {
        this.groupPath = options.path;
        this.channelDefs = [...options.channels];
    }

    /**
     * Create the group directory, start all channel servers, then write
     * group.json metadata. group.json is written last so that any process
     * reading it can be confident all listed channels are already listening.
     */
    async start(): Promise<void> {
        if (this._started) {
            throw new Error("ChannelGroup already started");
        }

        // Create group directory
        fs.mkdirSync(this.groupPath, { recursive: true });

        // Start all channels
        for (const def of this.channelDefs) {
            await this.startChannel(def);
        }

        this._started = true;

        // Write metadata AFTER all channels are listening (avoids race condition)
        this.writeGroupJson();
    }

    /**
     * Stop all channels, remove socket files, optionally remove directory.
     */
    async stop(options?: { removeDir?: boolean }): Promise<void> {
        if (!this._started) return;

        this._started = false;

        // Stop all channels
        const stopPromises: Promise<void>[] = [];
        for (const channel of this.channels.values()) {
            stopPromises.push(channel.stop());
        }
        await Promise.all(stopPromises);
        this.channels.clear();

        // Remove group.json
        const metaPath = path.join(this.groupPath, "group.json");
        try {
            fs.unlinkSync(metaPath);
        } catch {
            // Ignore
        }

        // Optionally remove the directory
        if (options?.removeDir) {
            try {
                fs.rmSync(this.groupPath, { recursive: true, force: true });
            } catch {
                // Ignore — directory may have other files
            }
        }
    }

    /** Get a channel by name. */
    channel(name: string): Channel {
        const ch = this.channels.get(name);
        if (!ch) {
            throw new Error(`Channel "${name}" not found in group`);
        }
        return ch;
    }

    /** List all channel names. */
    list(): string[] {
        return Array.from(this.channels.keys());
    }

    /** Add a channel to a running group. */
    async addChannel(def: GroupChannelDef): Promise<Channel> {
        if (!this._started) {
            throw new Error("ChannelGroup not started — call start() first");
        }

        if (this.channels.has(def.name)) {
            throw new Error(`Channel "${def.name}" already exists in group`);
        }

        const channel = await this.startChannel(def);
        this.channelDefs.push(def);

        // Re-write group.json with updated channel list
        this.writeGroupJson();

        return channel;
    }

    /** Whether the group is currently running. */
    get started(): boolean {
        return this._started;
    }

    /** The group directory path. */
    get path(): string {
        return this.groupPath;
    }

    private async startChannel(def: GroupChannelDef): Promise<Channel> {
        const socketPath = path.join(this.groupPath, `${def.name}.sock`);
        const channel = new Channel({
            path: socketPath,
            ...def.options,
        });

        await channel.start();
        this.channels.set(def.name, channel);
        return channel;
    }

    private writeGroupJson(): void {
        const metadata: GroupMetadata = {
            created: new Date().toISOString(),
            pid: process.pid,
            channels: this.channelDefs.map((d) => ({
                name: d.name,
                ...(d.inbox ? { inbox: true } : {}),
            })),
        };

        const metaPath = path.join(this.groupPath, "group.json");
        fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2) + "\n");
    }
}
