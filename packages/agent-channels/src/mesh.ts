import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { Channel } from "./channel.js";
import { type Message } from "./message.js";

export interface MeshOptions {
    /** This agent's name. */
    name: string;
    /** Directory for socket files. Created if it doesn't exist. */
    dir: string;
}

export interface MessageMeta {
    /** Which channel or "dm". */
    channel: string;
    /** Sender name. */
    from: string;
}

/**
 * A Mesh groups related channels inside one socket directory.
 *
 * It always joins `general` and the agent's own DM inbox channel on startup.
 * Topic channels are ordinary channels. DMs are ordinary channels named `dm-<name>`.
 */
export class Mesh extends EventEmitter {
    private readonly _name: string;
    private readonly dir: string;
    private readonly channelMap: Map<string, Channel> = new Map();
    private _joined = false;

    constructor(options: MeshOptions) {
        super();
        this._name = options.name;
        this.dir = options.dir;
    }

    async join(channel?: string): Promise<void> {
        if (!this._joined && !channel) {
            fs.mkdirSync(this.dir, { recursive: true });
            await this.joinChannel("general");
            await this.joinChannel(this.dmChannelName(this._name));
            this._joined = true;
            return;
        }

        if (channel) {
            if (!this._joined) {
                await this.join();
            }
            await this.joinChannel(channel);
        }
    }

    async joinChannel(channel: string): Promise<void> {
        if (this.channelMap.has(channel)) return;

        const instance = new Channel({
            path: path.join(this.dir, `${channel}.sock`),
            name: this._name,
            echoToSender: false,
        });

        instance.on("message", (msg: Message, from: string) => {
            this.emit("message", msg, {
                channel: this.publicChannelName(channel),
                from,
            } satisfies MessageMeta);
        });

        if (!isDmChannel(channel)) {
            instance.on("join", (name: string) => {
                this.emit("join", name, channel);
            });
            instance.on("leave", (name: string) => {
                this.emit("leave", name, channel);
            });
        }

        instance.on("error", (err: Error) => {
            this.emit("error", err);
        });

        await instance.join();
        this.channelMap.set(channel, instance);
    }

    async leave(channel?: string): Promise<void> {
        if (channel) {
            const instance = this.channelMap.get(channel);
            if (!instance) return;
            await instance.leave();
            this.channelMap.delete(channel);
            return;
        }

        this._joined = false;
        const leaves = Array.from(this.channelMap.values()).map((instance) => instance.leave());
        await Promise.all(leaves);
        this.channelMap.clear();
    }

    async leaveChannel(channel: string): Promise<void> {
        await this.leave(channel);
    }

    send(message: string, options?: { channel?: string }): void {
        this.sendAs(this._name, message, options);
    }

    sendAs(sender: string, message: string, options?: { channel?: string }): void {
        const channelName = options?.channel ?? "general";
        const instance = this.channelMap.get(channelName);
        if (!instance) {
            throw new Error(`Not in channel "${channelName}"`);
        }

        instance.send({
            msg: message,
            data: { type: isDmChannel(channelName) ? "dm" : "chat", from: sender, channel: channelName },
        });
    }

    async sendTo(target: string, message: string): Promise<void> {
        await this.sendToAs(this._name, target, message);
    }

    async sendToAs(sender: string, target: string, message: string): Promise<void> {
        const channelName = this.dmChannelName(target);
        const existing = this.channelMap.get(channelName);

        if (existing) {
            await this.ensureDmTargetPresent(existing, target);
            existing.send({
                msg: message,
                data: { type: "dm", from: sender, to: target, channel: channelName },
            });
            return;
        }

        const temp = new Channel({
            path: path.join(this.dir, `${channelName}.sock`),
            name: this._name,
            echoToSender: false,
        });

        try {
            await temp.join();
            await this.ensureDmTargetPresent(temp, target);
            temp.send({
                msg: message,
                data: { type: "dm", from: sender, to: target, channel: channelName },
            });
            await wait(50);
        } finally {
            await temp.leave();
        }
    }

    get channels(): string[] {
        return Array.from(this.channelMap.keys()).filter((channel) => !isDmChannel(channel));
    }

    allMembers(): string[] {
        const members = new Set<string>();
        for (const [channelName, instance] of this.channelMap) {
            if (isDmChannel(channelName)) continue;
            for (const member of instance.members) {
                members.add(member);
            }
        }
        return Array.from(members);
    }

    channelMembers(channel: string): string[] {
        const instance = this.channelMap.get(channel);
        if (!instance) return [];
        return instance.members;
    }

    get name(): string {
        return this._name;
    }

    get joined(): boolean {
        return this._joined;
    }

    get socketDir(): string {
        return this.dir;
    }

    private dmChannelName(target: string): string {
        return `dm-${target}`;
    }

    private publicChannelName(channelName: string): string {
        return isDmChannel(channelName) ? "dm" : channelName;
    }

    private async ensureDmTargetPresent(channel: Channel, target: string): Promise<void> {
        for (let attempt = 0; attempt < 5; attempt++) {
            if (channel.members.includes(target)) {
                return;
            }
            await wait(25);
        }

        throw new Error(`Cannot reach ${target} — they may be offline`);
    }
}

function isDmChannel(channelName: string): boolean {
    return channelName.startsWith("dm-");
}

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
