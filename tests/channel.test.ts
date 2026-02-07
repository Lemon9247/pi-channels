import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Channel } from "../src/channel.js";
import { ChannelClient } from "../src/client.js";
import type { Message } from "../src/message.js";

function tmpSocketPath(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ch-test-"));
    return path.join(dir, "test.sock");
}

// Collect channels/clients for cleanup
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

describe("Channel", () => {
    it("starts and creates socket file", async () => {
        const sockPath = tmpSocketPath();
        const channel = track(new Channel({ path: sockPath }));
        await channel.start();
        assert.ok(fs.existsSync(sockPath));
        assert.equal(channel.started, true);
        assert.equal(channel.clientCount, 0);
        await channel.stop();
    });

    it("stop removes socket file", async () => {
        const sockPath = tmpSocketPath();
        const channel = new Channel({ path: sockPath });
        await channel.start();
        await channel.stop();
        assert.ok(!fs.existsSync(sockPath));
        assert.equal(channel.started, false);
    });

    it("client can connect", async () => {
        const sockPath = tmpSocketPath();
        const channel = track(new Channel({ path: sockPath }));
        await channel.start();

        const connectPromise = new Promise<string>((resolve) => {
            channel.on("connect", resolve);
        });

        const client = track(new ChannelClient(sockPath));
        await client.connect();
        assert.ok(client.connected);

        const clientId = await connectPromise;
        assert.ok(clientId.startsWith("client-"));
        assert.equal(channel.clientCount, 1);

        client.disconnect();
        await channel.stop();
    });

    it("fans out messages to other clients (sender excluded)", async () => {
        const sockPath = tmpSocketPath();
        const channel = track(new Channel({ path: sockPath }));
        await channel.start();

        const client1 = track(new ChannelClient(sockPath));
        const client2 = track(new ChannelClient(sockPath));
        const client3 = track(new ChannelClient(sockPath));
        await client1.connect();
        await client2.connect();
        await client3.connect();

        const received2: Message[] = [];
        const received3: Message[] = [];
        let received1Count = 0;

        client1.on("message", () => received1Count++);
        client2.on("message", (msg: Message) => received2.push(msg));
        client3.on("message", (msg: Message) => received3.push(msg));

        const msg: Message = { msg: "hello from client1" };
        client1.send(msg);

        // Wait for delivery
        await new Promise((r) => setTimeout(r, 50));

        assert.equal(received1Count, 0, "sender should not receive own message");
        assert.equal(received2.length, 1);
        assert.equal(received3.length, 1);
        assert.deepEqual(received2[0], msg);
        assert.deepEqual(received3[0], msg);

        client1.disconnect();
        client2.disconnect();
        client3.disconnect();
        await channel.stop();
    });

    it("echoToSender sends message back to sender", async () => {
        const sockPath = tmpSocketPath();
        const channel = track(new Channel({ path: sockPath, echoToSender: true }));
        await channel.start();

        const client = track(new ChannelClient(sockPath));
        await client.connect();

        const received: Message[] = [];
        client.on("message", (msg: Message) => received.push(msg));

        client.send({ msg: "echo test" });
        await new Promise((r) => setTimeout(r, 50));

        assert.equal(received.length, 1);
        assert.equal(received[0]!.msg, "echo test");

        client.disconnect();
        await channel.stop();
    });

    it("broadcast sends to all clients (no sender exclusion)", async () => {
        const sockPath = tmpSocketPath();
        const channel = track(new Channel({ path: sockPath }));
        await channel.start();

        const client1 = track(new ChannelClient(sockPath));
        const client2 = track(new ChannelClient(sockPath));
        await client1.connect();
        await client2.connect();

        const received1: Message[] = [];
        const received2: Message[] = [];
        client1.on("message", (msg: Message) => received1.push(msg));
        client2.on("message", (msg: Message) => received2.push(msg));

        channel.broadcast({ msg: "server broadcast" });
        await new Promise((r) => setTimeout(r, 50));

        assert.equal(received1.length, 1);
        assert.equal(received2.length, 1);
        assert.equal(received1[0]!.msg, "server broadcast");

        client1.disconnect();
        client2.disconnect();
        await channel.stop();
    });

    it("emits message event with clientId", async () => {
        const sockPath = tmpSocketPath();
        const channel = track(new Channel({ path: sockPath }));
        await channel.start();

        const client = track(new ChannelClient(sockPath));
        await client.connect();

        const messagePromise = new Promise<{ msg: Message; clientId: string }>((resolve) => {
            channel.on("message", (msg: Message, clientId: string) => {
                resolve({ msg, clientId });
            });
        });

        client.send({ msg: "event test" });
        const { msg, clientId } = await messagePromise;

        assert.equal(msg.msg, "event test");
        assert.ok(clientId.startsWith("client-"));

        client.disconnect();
        await channel.stop();
    });

    it("emits disconnect when client disconnects", async () => {
        const sockPath = tmpSocketPath();
        const channel = track(new Channel({ path: sockPath }));
        await channel.start();

        const client = track(new ChannelClient(sockPath));
        await client.connect();

        const disconnectPromise = new Promise<string>((resolve) => {
            channel.on("disconnect", resolve);
        });

        client.disconnect();
        const clientId = await disconnectPromise;
        assert.ok(clientId.startsWith("client-"));
        assert.equal(channel.clientCount, 0);

        await channel.stop();
    });

    it("handles multiple clients connecting and disconnecting", async () => {
        const sockPath = tmpSocketPath();
        const channel = track(new Channel({ path: sockPath }));
        await channel.start();

        const clients: ChannelClient[] = [];
        for (let i = 0; i < 5; i++) {
            const c = track(new ChannelClient(sockPath));
            await c.connect();
            clients.push(c);
        }
        assert.equal(channel.clientCount, 5);

        clients[0]!.disconnect();
        clients[1]!.disconnect();
        await new Promise((r) => setTimeout(r, 30));
        assert.equal(channel.clientCount, 3);

        for (const c of clients.slice(2)) c.disconnect();
        await new Promise((r) => setTimeout(r, 30));
        assert.equal(channel.clientCount, 0);

        await channel.stop();
    });

    it("cleans stale socket from crashed process", async () => {
        const sockPath = tmpSocketPath();

        // Create a fake stale socket file
        fs.writeFileSync(sockPath, "");

        const channel = track(new Channel({ path: sockPath }));
        await channel.start(); // Should detect stale socket and clean it up
        assert.ok(channel.started);

        await channel.stop();
    });

    it("throws when socket is already in use by another channel", async () => {
        const sockPath = tmpSocketPath();
        const channel1 = track(new Channel({ path: sockPath }));
        await channel1.start();

        const channel2 = new Channel({ path: sockPath });
        await assert.rejects(() => channel2.start(), /already in use/);

        await channel1.stop();
    });

    it("throws on double start", async () => {
        const sockPath = tmpSocketPath();
        const channel = track(new Channel({ path: sockPath }));
        await channel.start();
        await assert.rejects(() => channel.start(), /already started/);
        await channel.stop();
    });

    it("stop is idempotent", async () => {
        const sockPath = tmpSocketPath();
        const channel = new Channel({ path: sockPath });
        await channel.start();
        await channel.stop();
        await channel.stop(); // Should not throw
    });

    it("exposes path property", () => {
        const sockPath = "/tmp/test-path.sock";
        const channel = new Channel({ path: sockPath });
        assert.equal(channel.path, sockPath);
    });
});
