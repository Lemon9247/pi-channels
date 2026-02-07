import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Channel, ChannelClient, type Message, encode, FrameDecoder } from "../../src/index.js";
import { TcpBridgeServer } from "../../src/bridges/tcp.js";

function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "tcp-bridge-server-"));
}

function wait(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

/** Connect a raw TCP socket and return it with a frame decoder. */
function connectTcp(port: number, host = "127.0.0.1"): Promise<{ socket: net.Socket; decoder: FrameDecoder }> {
    return new Promise((resolve, reject) => {
        const socket = net.connect(port, host);
        const decoder = new FrameDecoder();
        socket.on("connect", () => resolve({ socket, decoder }));
        socket.on("error", reject);
    });
}

describe("TcpBridgeServer", () => {
    let dir: string;
    let channel: Channel;
    let bridge: TcpBridgeServer;

    beforeEach(async () => {
        dir = tmpDir();
        const sockPath = path.join(dir, "test.sock");
        channel = new Channel({ path: sockPath });
        await channel.start();
        bridge = new TcpBridgeServer({ channelPath: sockPath, port: 0 });
    });

    afterEach(async () => {
        await bridge.stop();
        await channel.stop();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("starts and stops cleanly", async () => {
        assert.equal(bridge.status, "stopped");
        await bridge.start();
        assert.equal(bridge.status, "running");
        assert.notEqual(bridge.address, null);
        await bridge.stop();
        assert.equal(bridge.status, "stopped");
    });

    it("forwards messages from local channel to TCP client", async () => {
        await bridge.start();
        const port = bridge.address!.port;

        // Connect a TCP client
        const { socket, decoder } = await connectTcp(port);
        await wait(50);

        // Connect a local channel client and send a message
        const local = new ChannelClient(channel.path);
        await local.connect();
        local.send({ msg: "hello from local" });

        // TCP client should receive the message
        const received: Message[] = [];
        socket.on("data", (chunk: Buffer) => {
            received.push(...decoder.push(chunk));
        });

        await wait(100);
        assert.equal(received.length, 1);
        assert.equal(received[0].msg, "hello from local");

        local.disconnect();
        socket.destroy();
    });

    it("forwards messages from TCP client to local channel", async () => {
        await bridge.start();
        const port = bridge.address!.port;

        // Connect a local channel client to receive
        const local = new ChannelClient(channel.path);
        await local.connect();

        const received: Message[] = [];
        local.on("message", (msg: Message) => received.push(msg));

        // Connect a TCP client and send a message
        const { socket } = await connectTcp(port);
        await wait(50);

        socket.write(encode({ msg: "hello from tcp" }));

        await wait(100);
        assert.equal(received.length, 1);
        assert.equal(received[0].msg, "hello from tcp");

        local.disconnect();
        socket.destroy();
    });

    it("emits tcp-connect and tcp-disconnect events", async () => {
        await bridge.start();
        const port = bridge.address!.port;

        const events: string[] = [];
        bridge.on("tcp-connect", () => events.push("connect"));
        bridge.on("tcp-disconnect", () => events.push("disconnect"));

        const { socket } = await connectTcp(port);
        await wait(50);
        assert.deepEqual(events, ["connect"]);

        socket.destroy();
        await wait(50);
        assert.deepEqual(events, ["connect", "disconnect"]);
    });

    it("throws if started twice", async () => {
        await bridge.start();
        await assert.rejects(() => bridge.start(), /already running/);
    });

    it("stop is idempotent", async () => {
        await bridge.stop(); // not started
        await bridge.start();
        await bridge.stop();
        await bridge.stop(); // already stopped
    });
});
