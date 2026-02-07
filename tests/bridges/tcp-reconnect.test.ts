import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Channel, ChannelClient, type Message } from "../../src/index.js";
import { TcpBridgeServer, TcpBridgeClient } from "../../src/bridges/tcp.js";

function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "tcp-bridge-reconnect-"));
}

function wait(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

describe("TcpBridgeClient reconnection", () => {
    let dir: string;
    const cleanup: Array<{ stop(): Promise<void> } | { disconnect(): void }> = [];

    afterEach(async () => {
        for (const item of cleanup.reverse()) {
            try {
                if ("stop" in item) await item.stop();
                else item.disconnect();
            } catch { /* ignore */ }
        }
        cleanup.length = 0;
        if (dir) fs.rmSync(dir, { recursive: true, force: true });
    });

    it("reconnects after TCP server restarts", async () => {
        dir = tmpDir();

        const serverChannel = new Channel({ path: path.join(dir, "server.sock") });
        await serverChannel.start();
        cleanup.push(serverChannel);

        let server = new TcpBridgeServer({ channelPath: serverChannel.path, port: 0 });
        await server.start();
        const port = server.address!.port;

        const clientChannel = new Channel({ path: path.join(dir, "client.sock") });
        await clientChannel.start();
        cleanup.push(clientChannel);

        const bridgeClient = new TcpBridgeClient({
            channelPath: clientChannel.path,
            host: "127.0.0.1",
            port,
            reconnect: true,
            reconnectDelay: 100,
            maxReconnectDelay: 500,
        });
        await bridgeClient.start();
        cleanup.push(bridgeClient);

        // Track reconnect events
        const reconnectEvents: Array<{ attempt: number; delay: number }> = [];
        bridgeClient.on("reconnecting", (attempt: number, delay: number) => {
            reconnectEvents.push({ attempt, delay });
        });

        let reconnected = false;
        let disconnected = false;

        bridgeClient.on("tcp-disconnect", () => { disconnected = true; });

        // Kill the server
        await server.stop();
        await wait(200);
        assert.equal(disconnected, true);
        assert.ok(reconnectEvents.length >= 1, "Should have attempted reconnect");

        // Restart server on the same port
        server = new TcpBridgeServer({ channelPath: serverChannel.path, port });
        await server.start();
        cleanup.push(server);

        bridgeClient.on("tcp-connect", () => { reconnected = true; });

        // Wait for reconnect
        await wait(2000);
        assert.equal(reconnected, true, "Should have reconnected");

        // Verify messages flow after reconnect
        const listener = new ChannelClient(serverChannel.path);
        await listener.connect();
        cleanup.push(listener);

        const received: Message[] = [];
        listener.on("message", (msg: Message) => received.push(msg));

        const sender = new ChannelClient(clientChannel.path);
        await sender.connect();
        cleanup.push(sender);

        sender.send({ msg: "after reconnect" });
        await wait(150);

        assert.equal(received.length, 1);
        assert.equal(received[0].msg, "after reconnect");
    });

    it("exponential backoff increases delay", async () => {
        dir = tmpDir();

        const serverChannel = new Channel({ path: path.join(dir, "server2.sock") });
        await serverChannel.start();
        cleanup.push(serverChannel);

        const server = new TcpBridgeServer({ channelPath: serverChannel.path, port: 0 });
        await server.start();
        const port = server.address!.port;

        const clientChannel = new Channel({ path: path.join(dir, "client2.sock") });
        await clientChannel.start();
        cleanup.push(clientChannel);

        const bridgeClient = new TcpBridgeClient({
            channelPath: clientChannel.path,
            host: "127.0.0.1",
            port,
            reconnect: true,
            reconnectDelay: 50,
            maxReconnectDelay: 400,
        });
        await bridgeClient.start();
        cleanup.push(bridgeClient);

        const delays: number[] = [];
        bridgeClient.on("reconnecting", (_attempt: number, delay: number) => {
            delays.push(delay);
        });

        // Kill server — no restart, so client keeps retrying
        await server.stop();
        await wait(1500);

        // Should have multiple attempts with increasing delays
        assert.ok(delays.length >= 3, `Expected >= 3 attempts, got ${delays.length}`);
        // First delay should be 50, then 100, then 200, then capped at 400
        assert.equal(delays[0], 50);
        assert.equal(delays[1], 100);
        assert.equal(delays[2], 200);
        if (delays.length >= 4) {
            assert.equal(delays[3], 400);
        }
        if (delays.length >= 5) {
            assert.equal(delays[4], 400); // capped
        }
    });

    it("does not reconnect when reconnect is disabled", async () => {
        dir = tmpDir();

        const serverChannel = new Channel({ path: path.join(dir, "server3.sock") });
        await serverChannel.start();
        cleanup.push(serverChannel);

        const server = new TcpBridgeServer({ channelPath: serverChannel.path, port: 0 });
        await server.start();
        const port = server.address!.port;

        const clientChannel = new Channel({ path: path.join(dir, "client3.sock") });
        await clientChannel.start();
        cleanup.push(clientChannel);

        const bridgeClient = new TcpBridgeClient({
            channelPath: clientChannel.path,
            host: "127.0.0.1",
            port,
            reconnect: false,
        });
        await bridgeClient.start();
        cleanup.push(bridgeClient);

        let reconnecting = false;
        bridgeClient.on("reconnecting", () => { reconnecting = true; });

        await server.stop();
        await wait(300);

        assert.equal(reconnecting, false);
    });
});
