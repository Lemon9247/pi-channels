import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Channel, ChannelClient, type Message, encode, FrameDecoder } from "../../src/index.js";
import { TcpBridgeServer } from "../../src/bridges/tcp.js";

function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "tcp-bridge-multi-"));
}

function wait(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

function connectTcp(port: number): Promise<{ socket: net.Socket; decoder: FrameDecoder; messages: Message[] }> {
    return new Promise((resolve, reject) => {
        const socket = net.connect(port, "127.0.0.1");
        const decoder = new FrameDecoder();
        const messages: Message[] = [];

        socket.on("connect", () => {
            socket.on("data", (chunk: Buffer) => {
                messages.push(...decoder.push(chunk));
            });
            resolve({ socket, decoder, messages });
        });
        socket.on("error", reject);
    });
}

describe("TcpBridgeServer multi-client fan-out", () => {
    let dir: string;
    let channel: Channel;
    let bridge: TcpBridgeServer;

    afterEach(async () => {
        if (bridge) await bridge.stop();
        if (channel) await channel.stop();
        if (dir) fs.rmSync(dir, { recursive: true, force: true });
    });

    it("fans out channel messages to all TCP clients", async () => {
        dir = tmpDir();
        channel = new Channel({ path: path.join(dir, "ch.sock") });
        await channel.start();

        bridge = new TcpBridgeServer({ channelPath: channel.path, port: 0 });
        await bridge.start();

        // Connect 3 TCP clients
        const clients = await Promise.all([
            connectTcp(bridge.address!.port),
            connectTcp(bridge.address!.port),
            connectTcp(bridge.address!.port),
        ]);
        await wait(50);

        // Local agent sends a message
        const local = new ChannelClient(channel.path);
        await local.connect();
        local.send({ msg: "broadcast to all" });

        await wait(150);

        // All 3 TCP clients should receive it
        for (let i = 0; i < 3; i++) {
            assert.equal(clients[i].messages.length, 1, `Client ${i} should have 1 message`);
            assert.equal(clients[i].messages[0].msg, "broadcast to all");
        }

        local.disconnect();
        for (const c of clients) c.socket.destroy();
    });

    it("messages from one TCP client reach other TCP clients via channel", async () => {
        dir = tmpDir();
        channel = new Channel({ path: path.join(dir, "ch2.sock") });
        await channel.start();

        bridge = new TcpBridgeServer({ channelPath: channel.path, port: 0 });
        await bridge.start();

        const client1 = await connectTcp(bridge.address!.port);
        const client2 = await connectTcp(bridge.address!.port);
        await wait(50);

        // Client 1 sends a message
        client1.socket.write(encode({ msg: "from client 1" }));

        await wait(150);

        // Client 2 should receive it (routed through channel fan-out back to bridge, then to client 2)
        // Note: the bridge client sends to the channel, channel fans out to bridge's own
        // channel client, bridge forwards to all TCP clients. Client 1 will also receive
        // (since the bridge is a separate channel client, the channel sees the bridge as sender
        // and fans out to all *other* channel clients — but the bridge's channel client receives
        // and forwards to ALL TCP clients including the original sender).
        assert.equal(client2.messages.length, 1);
        assert.equal(client2.messages[0].msg, "from client 1");

        client1.socket.destroy();
        client2.socket.destroy();
    });

    it("handles TCP client disconnection without affecting others", async () => {
        dir = tmpDir();
        channel = new Channel({ path: path.join(dir, "ch3.sock") });
        await channel.start();

        bridge = new TcpBridgeServer({ channelPath: channel.path, port: 0 });
        await bridge.start();

        const client1 = await connectTcp(bridge.address!.port);
        const client2 = await connectTcp(bridge.address!.port);
        const client3 = await connectTcp(bridge.address!.port);
        await wait(50);

        // Disconnect client 2
        client2.socket.destroy();
        await wait(50);

        // Send a message from local — clients 1 and 3 should still receive
        const local = new ChannelClient(channel.path);
        await local.connect();
        local.send({ msg: "after disconnect" });

        await wait(150);

        assert.equal(client1.messages.length, 1);
        assert.equal(client1.messages[0].msg, "after disconnect");
        assert.equal(client3.messages.length, 1);
        assert.equal(client3.messages[0].msg, "after disconnect");

        local.disconnect();
        client1.socket.destroy();
        client3.socket.destroy();
    });
});
