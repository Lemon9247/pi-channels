import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Channel } from "../src/channel.js";
import { ChannelClient } from "../src/client.js";
import type { Message } from "../src/message.js";

function tmpSocketPath(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cl-test-"));
    return path.join(dir, "test.sock");
}

const cleanup: Array<{ stop?: () => Promise<void>; disconnect?: () => void }> = [];

afterEach(async () => {
    for (const item of cleanup) {
        try {
            if (item.disconnect) item.disconnect();
            if (item.stop) await item.stop();
        } catch { /* ignore */ }
    }
    cleanup.length = 0;
});

function track<T extends { stop?: () => Promise<void>; disconnect?: () => void }>(item: T): T {
    cleanup.push(item as any);
    return item;
}

describe("ChannelClient", () => {
    it("connects and reports connected state", async () => {
        const sockPath = tmpSocketPath();
        const channel = track(new Channel({ path: sockPath }));
        await channel.start();

        const client = track(new ChannelClient(sockPath));
        assert.equal(client.connected, false);

        await client.connect();
        assert.equal(client.connected, true);

        client.disconnect();
        await channel.stop();
    });

    it("emits connect event", async () => {
        const sockPath = tmpSocketPath();
        const channel = track(new Channel({ path: sockPath }));
        await channel.start();

        const client = track(new ChannelClient(sockPath));
        let connectEmitted = false;
        client.on("connect", () => { connectEmitted = true; });

        await client.connect();
        assert.ok(connectEmitted);

        client.disconnect();
        await channel.stop();
    });

    it("emits disconnect event when server stops", async () => {
        const sockPath = tmpSocketPath();
        const channel = track(new Channel({ path: sockPath }));
        await channel.start();

        const client = track(new ChannelClient(sockPath));
        await client.connect();

        const disconnectPromise = new Promise<void>((resolve) => {
            client.on("disconnect", resolve);
        });

        await channel.stop();
        await disconnectPromise;
        assert.equal(client.connected, false);
    });

    it("send throws when not connected", () => {
        const client = new ChannelClient("/nonexistent.sock");
        assert.throws(() => client.send({ msg: "b" }), /Not connected/);
    });

    it("throws on double connect", async () => {
        const sockPath = tmpSocketPath();
        const channel = track(new Channel({ path: sockPath }));
        await channel.start();

        const client = track(new ChannelClient(sockPath));
        await client.connect();
        await assert.rejects(() => client.connect(), /Already connected/);

        client.disconnect();
        await channel.stop();
    });

    it("rejects connect when no server is listening", async () => {
        const client = new ChannelClient("/tmp/nonexistent-test-socket-" + Date.now() + ".sock");
        await assert.rejects(() => client.connect());
    });

    it("can reconnect after disconnect", async () => {
        const sockPath = tmpSocketPath();
        const channel = track(new Channel({ path: sockPath }));
        await channel.start();

        const client = track(new ChannelClient(sockPath));
        await client.connect();
        assert.equal(client.connected, true);

        client.disconnect();
        assert.equal(client.connected, false);

        // Reconnect
        await client.connect();
        assert.equal(client.connected, true);

        client.disconnect();
        await channel.stop();
    });

    it("receives messages from other clients", async () => {
        const sockPath = tmpSocketPath();
        const channel = track(new Channel({ path: sockPath }));
        await channel.start();

        const sender = track(new ChannelClient(sockPath));
        const receiver = track(new ChannelClient(sockPath));
        await sender.connect();
        await receiver.connect();

        const received: Message[] = [];
        receiver.on("message", (msg: Message) => received.push(msg));

        sender.send({ msg: "hello", data: { n: 1 } });
        sender.send({ msg: "world", data: { n: 2 } });

        await new Promise((r) => setTimeout(r, 50));

        assert.equal(received.length, 2);
        assert.equal(received[0]!.msg, "hello");
        assert.equal(received[1]!.msg, "world");

        sender.disconnect();
        receiver.disconnect();
        await channel.stop();
    });

    it("disconnect is idempotent", async () => {
        const sockPath = tmpSocketPath();
        const channel = track(new Channel({ path: sockPath }));
        await channel.start();

        const client = track(new ChannelClient(sockPath));
        await client.connect();
        client.disconnect();
        client.disconnect(); // Should not throw
        assert.equal(client.connected, false);

        await channel.stop();
    });
});
