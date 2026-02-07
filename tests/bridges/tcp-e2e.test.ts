import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Channel, ChannelClient, type Message } from "../../src/index.js";
import { TcpBridgeServer, TcpBridgeClient } from "../../src/bridges/tcp.js";

function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "tcp-bridge-e2e-"));
}

function wait(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

describe("TCP Bridge E2E — two-machine simulation", () => {
    let dir: string;
    const cleanup: Array<{ stop(): Promise<void> } | { disconnect(): void }> = [];

    afterEach(async () => {
        // Reverse order cleanup
        for (const item of cleanup.reverse()) {
            try {
                if ("stop" in item) await item.stop();
                else item.disconnect();
            } catch { /* ignore */ }
        }
        cleanup.length = 0;
        if (dir) fs.rmSync(dir, { recursive: true, force: true });
    });

    it("messages flow bidirectionally between two bridged channel groups", async () => {
        dir = tmpDir();

        // ── Machine A ──
        const channelA = new Channel({ path: path.join(dir, "a", "general.sock") });
        await channelA.start();
        cleanup.push(channelA);

        const bridgeServerA = new TcpBridgeServer({
            channelPath: channelA.path,
            port: 0,
        });
        await bridgeServerA.start();
        cleanup.push(bridgeServerA);

        // ── Machine B ──
        const channelB = new Channel({ path: path.join(dir, "b", "general.sock") });
        await channelB.start();
        cleanup.push(channelB);

        const bridgeClientB = new TcpBridgeClient({
            channelPath: channelB.path,
            host: "127.0.0.1",
            port: bridgeServerA.address!.port,
            reconnect: false,
        });
        await bridgeClientB.start();
        cleanup.push(bridgeClientB);

        // ── Agents ──
        // Agent on Machine A
        const agentA = new ChannelClient(channelA.path);
        await agentA.connect();
        cleanup.push(agentA);

        // Agent on Machine B
        const agentB = new ChannelClient(channelB.path);
        await agentB.connect();
        cleanup.push(agentB);

        const receivedByA: Message[] = [];
        const receivedByB: Message[] = [];
        agentA.on("message", (msg: Message) => receivedByA.push(msg));
        agentB.on("message", (msg: Message) => receivedByB.push(msg));

        // A sends, B should receive
        agentA.send({ msg: "hello from A", data: { sender: "agent-a" } });
        await wait(150);
        assert.equal(receivedByB.length, 1);
        assert.equal(receivedByB[0].msg, "hello from A");
        assert.equal(receivedByB[0].data?.sender, "agent-a");

        // B sends, A should receive
        agentB.send({ msg: "hello from B", data: { sender: "agent-b" } });
        await wait(150);
        assert.equal(receivedByA.length, 1);
        assert.equal(receivedByA[0].msg, "hello from B");
        assert.equal(receivedByA[0].data?.sender, "agent-b");
    });

    it("multiple messages flow correctly in both directions", async () => {
        dir = tmpDir();

        const channelA = new Channel({ path: path.join(dir, "a2", "ch.sock") });
        await channelA.start();
        cleanup.push(channelA);

        const bridgeServer = new TcpBridgeServer({ channelPath: channelA.path, port: 0 });
        await bridgeServer.start();
        cleanup.push(bridgeServer);

        const channelB = new Channel({ path: path.join(dir, "b2", "ch.sock") });
        await channelB.start();
        cleanup.push(channelB);

        const bridgeClient = new TcpBridgeClient({
            channelPath: channelB.path,
            host: "127.0.0.1",
            port: bridgeServer.address!.port,
            reconnect: false,
        });
        await bridgeClient.start();
        cleanup.push(bridgeClient);

        const agentA = new ChannelClient(channelA.path);
        await agentA.connect();
        cleanup.push(agentA);

        const agentB = new ChannelClient(channelB.path);
        await agentB.connect();
        cleanup.push(agentB);

        const receivedByA: Message[] = [];
        const receivedByB: Message[] = [];
        agentA.on("message", (msg: Message) => receivedByA.push(msg));
        agentB.on("message", (msg: Message) => receivedByB.push(msg));

        // Send 5 messages from A
        for (let i = 0; i < 5; i++) {
            agentA.send({ msg: `a-${i}` });
        }

        // Send 5 messages from B
        for (let i = 0; i < 5; i++) {
            agentB.send({ msg: `b-${i}` });
        }

        await wait(200);

        assert.equal(receivedByB.length, 5);
        assert.equal(receivedByA.length, 5);

        for (let i = 0; i < 5; i++) {
            assert.equal(receivedByB[i].msg, `a-${i}`);
            assert.equal(receivedByA[i].msg, `b-${i}`);
        }
    });
});
