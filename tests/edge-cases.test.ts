import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as net from "node:net";
import { Channel } from "../src/channel.js";
import { ChannelClient } from "../src/client.js";
import type { Message } from "../src/message.js";

function tmpSocketPath(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "edge-test-"));
    return path.join(dir, "test.sock");
}

const cleanup: Array<{ stop?: () => Promise<void>; disconnect?: () => void; destroy?: () => void }> = [];

afterEach(async () => {
    for (const item of cleanup) {
        try {
            if (item.disconnect) item.disconnect();
            if (item.destroy) item.destroy();
            if (item.stop) await item.stop();
        } catch { /* ignore */ }
    }
    cleanup.length = 0;
});

function track<T extends Record<string, any>>(item: T): T {
    cleanup.push(item as any);
    return item;
}

describe("Edge cases", () => {
    it("stale socket from crash is cleaned up on start", async () => {
        const sockPath = tmpSocketPath();

        // Simulate a stale socket: create a regular file at the socket path.
        // When Channel.start() tries to connect, it gets ECONNREFUSED/ENOTSOCK
        // and treats it as stale.
        fs.writeFileSync(sockPath, "stale");
        assert.ok(fs.existsSync(sockPath));

        // Now start a channel — should detect stale and clean up
        const channel = track(new Channel({ path: sockPath }));
        await channel.start();
        assert.ok(channel.started);

        // Verify we can actually connect through it
        const client = track(new ChannelClient(sockPath));
        await client.connect();
        assert.ok(client.connected);

        client.disconnect();
        await channel.stop();
    });

    it("channel handles client sending malformed data", async () => {
        const sockPath = tmpSocketPath();
        const channel = track(new Channel({ path: sockPath }));
        await channel.start();

        // Connect with raw socket to send bad data
        const rawSocket = track(net.connect(sockPath));
        await new Promise<void>((resolve) => rawSocket.on("connect", resolve));
        await new Promise((r) => setTimeout(r, 20));

        assert.equal(channel.clientCount, 1);

        // Collect error events
        const errors: Error[] = [];
        channel.on("error", (err: Error) => errors.push(err));

        // Send a frame with invalid JSON
        const badPayload = Buffer.from("not json at all!!!", "utf-8");
        const frame = Buffer.alloc(4 + badPayload.length);
        frame.writeUInt32BE(badPayload.length, 0);
        badPayload.copy(frame, 4);
        rawSocket.write(frame);

        await new Promise((r) => setTimeout(r, 50));

        // Client should be disconnected, channel should survive
        assert.equal(channel.clientCount, 0);
        assert.ok(channel.started);
        assert.ok(errors.length > 0);

        await channel.stop();
    });

    it("channel handles client sending invalid Message (valid JSON, bad shape)", async () => {
        const sockPath = tmpSocketPath();
        const channel = track(new Channel({ path: sockPath }));
        await channel.start();

        const rawSocket = track(net.connect(sockPath));
        await new Promise<void>((resolve) => rawSocket.on("connect", resolve));
        await new Promise((r) => setTimeout(r, 20));

        const errors: Error[] = [];
        channel.on("error", (err: Error) => errors.push(err));

        // Valid JSON but not a valid Message (missing required fields)
        const payload = Buffer.from(JSON.stringify({ foo: "bar" }), "utf-8");
        const frame = Buffer.alloc(4 + payload.length);
        frame.writeUInt32BE(payload.length, 0);
        payload.copy(frame, 4);
        rawSocket.write(frame);

        await new Promise((r) => setTimeout(r, 50));

        assert.equal(channel.clientCount, 0);
        assert.ok(channel.started);
        assert.ok(errors.some((e) => e.message.includes("Invalid message format")));

        await channel.stop();
    });

    it("channel survives when one client in fan-out has disconnected", async () => {
        const sockPath = tmpSocketPath();
        const channel = track(new Channel({ path: sockPath }));
        await channel.start();

        const client1 = track(new ChannelClient(sockPath));
        const client2 = track(new ChannelClient(sockPath));
        const client3 = track(new ChannelClient(sockPath));
        await client1.connect();
        await client2.connect();
        await client3.connect();

        // Abruptly destroy client2's connection
        client2.disconnect();
        await new Promise((r) => setTimeout(r, 30));

        // client1 sends — should reach client3, not crash
        const received: Message[] = [];
        client3.on("message", (msg: Message) => received.push(msg));

        client1.send({ to: "test", msg: "after disconnect" });
        await new Promise((r) => setTimeout(r, 50));

        assert.equal(received.length, 1);
        assert.equal(received[0].msg, "after disconnect");
        assert.ok(channel.started);

        client1.disconnect();
        client3.disconnect();
        await channel.stop();
    });

    it("channel start throws when socket is actively in use", async () => {
        const sockPath = tmpSocketPath();
        const channel1 = track(new Channel({ path: sockPath }));
        await channel1.start();

        const channel2 = new Channel({ path: sockPath });
        await assert.rejects(() => channel2.start(), /already in use/);

        await channel1.stop();
    });

    it("group stop with connected clients doesn't crash", async () => {
        const groupPath = path.join(
            fs.mkdtempSync(path.join(os.tmpdir(), "edge-grp-")),
            "group"
        );

        // Import ChannelGroup
        const { ChannelGroup } = await import("../src/group.js");
        const group = new ChannelGroup({
            path: groupPath,
            channels: [{ name: "general" }, { name: "inbox-a1" }],
        });

        await group.start();

        // Connect clients to both channels
        const c1 = track(new ChannelClient(path.join(groupPath, "general.sock")));
        const c2 = track(new ChannelClient(path.join(groupPath, "inbox-a1.sock")));
        await c1.connect();
        await c2.connect();

        // Stop the group — should not throw
        await group.stop({ removeDir: true });
    });

    it("client emits error for malformed server data", async () => {
        const sockPath = tmpSocketPath();

        // Create a raw server that sends garbage
        const server = net.createServer((socket) => {
            // Send a frame with invalid JSON
            const bad = Buffer.from("broken", "utf-8");
            const frame = Buffer.alloc(4 + bad.length);
            frame.writeUInt32BE(bad.length, 0);
            bad.copy(frame, 4);
            socket.write(frame);
        });
        await new Promise<void>((resolve) => server.listen(sockPath, resolve));

        const client = new ChannelClient(sockPath);
        const errors: Error[] = [];
        client.on("error", (err: Error) => errors.push(err));

        await client.connect();
        await new Promise((r) => setTimeout(r, 50));

        assert.ok(errors.length > 0);

        client.disconnect();
        await new Promise<void>((resolve) => server.close(resolve));
        try { fs.unlinkSync(sockPath); } catch { /* ignore */ }
    });

    it("handles rapid connect/send/disconnect cycles", async () => {
        const sockPath = tmpSocketPath();
        const channel = track(new Channel({ path: sockPath }));
        await channel.start();

        // Rapid cycle 10 times
        for (let i = 0; i < 10; i++) {
            const client = new ChannelClient(sockPath);
            await client.connect();
            client.send({ to: "test", msg: `cycle ${i}` });
            client.disconnect();
        }

        await new Promise((r) => setTimeout(r, 50));
        assert.ok(channel.started);
        assert.equal(channel.clientCount, 0);

        await channel.stop();
    });

    it("large messages are transmitted correctly", async () => {
        const sockPath = tmpSocketPath();
        const channel = track(new Channel({ path: sockPath }));
        await channel.start();

        const client1 = track(new ChannelClient(sockPath));
        const client2 = track(new ChannelClient(sockPath));
        await client1.connect();
        await client2.connect();

        const received: Message[] = [];
        client2.on("message", (msg: Message) => received.push(msg));

        // Send a message with a large data payload (~100KB)
        const largeData: Record<string, string> = {};
        for (let i = 0; i < 1000; i++) {
            largeData[`key-${i}`] = "x".repeat(100);
        }

        client1.send({ to: "test", msg: "large message", data: largeData });
        await new Promise((r) => setTimeout(r, 200));

        assert.equal(received.length, 1);
        assert.equal(received[0].msg, "large message");
        assert.equal(Object.keys(received[0].data).length, 1000);

        client1.disconnect();
        client2.disconnect();
        await channel.stop();
    });
});
