import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Channel, ChannelClient, type Message } from "../../src/index.js";
import { TcpBridgeServer, TcpBridgeClient } from "../../src/bridges/tcp.js";

function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "tcp-bridge-client-"));
}

function wait(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

describe("TcpBridgeClient", () => {
    let dir: string;
    let serverChannel: Channel;
    let clientChannel: Channel;
    let server: TcpBridgeServer;
    let client: TcpBridgeClient;

    beforeEach(async () => {
        dir = tmpDir();

        // Server side: a channel + TCP bridge server
        const serverSockPath = path.join(dir, "server.sock");
        serverChannel = new Channel({ path: serverSockPath });
        await serverChannel.start();
        server = new TcpBridgeServer({ channelPath: serverSockPath, port: 0 });
        await server.start();

        // Client side channel (will be bridged to the server)
        const clientSockPath = path.join(dir, "client.sock");
        clientChannel = new Channel({ path: clientSockPath });
        await clientChannel.start();
    });

    afterEach(async () => {
        if (client) await client.stop();
        await server.stop();
        await serverChannel.stop();
        await clientChannel.stop();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("starts and stops cleanly", async () => {
        client = new TcpBridgeClient({
            channelPath: clientChannel.path,
            host: "127.0.0.1",
            port: server.address!.port,
            reconnect: false,
        });
        assert.equal(client.status, "stopped");
        await client.start();
        assert.equal(client.status, "running");
        await client.stop();
        assert.equal(client.status, "stopped");
    });

    it("forwards messages from client channel to server channel", async () => {
        client = new TcpBridgeClient({
            channelPath: clientChannel.path,
            host: "127.0.0.1",
            port: server.address!.port,
            reconnect: false,
        });
        await client.start();

        // Listen on server channel
        const serverListener = new ChannelClient(serverChannel.path);
        await serverListener.connect();
        const received: Message[] = [];
        serverListener.on("message", (msg: Message) => received.push(msg));

        // Send from client channel
        const sender = new ChannelClient(clientChannel.path);
        await sender.connect();
        sender.send({ msg: "from client side" });

        await wait(150);
        assert.equal(received.length, 1);
        assert.equal(received[0].msg, "from client side");

        sender.disconnect();
        serverListener.disconnect();
    });

    it("forwards messages from server channel to client channel", async () => {
        client = new TcpBridgeClient({
            channelPath: clientChannel.path,
            host: "127.0.0.1",
            port: server.address!.port,
            reconnect: false,
        });
        await client.start();

        // Listen on client channel
        const clientListener = new ChannelClient(clientChannel.path);
        await clientListener.connect();
        const received: Message[] = [];
        clientListener.on("message", (msg: Message) => received.push(msg));

        // Send from server channel
        const sender = new ChannelClient(serverChannel.path);
        await sender.connect();
        sender.send({ msg: "from server side" });

        await wait(150);
        assert.equal(received.length, 1);
        assert.equal(received[0].msg, "from server side");

        sender.disconnect();
        clientListener.disconnect();
    });

    it("emits tcp-connect event", async () => {
        client = new TcpBridgeClient({
            channelPath: clientChannel.path,
            host: "127.0.0.1",
            port: server.address!.port,
            reconnect: false,
        });

        let connected = false;
        client.on("tcp-connect", () => { connected = true; });

        await client.start();
        assert.equal(connected, true);
    });

    it("throws if started twice", async () => {
        client = new TcpBridgeClient({
            channelPath: clientChannel.path,
            host: "127.0.0.1",
            port: server.address!.port,
            reconnect: false,
        });
        await client.start();
        await assert.rejects(() => client.start(), /already running/);
    });
});
