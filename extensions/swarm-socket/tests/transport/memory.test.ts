/**
 * InMemoryTransport tests
 */

import { test, assert, assertEqual, delay, summarize } from "../helpers.js";
import {
    InMemoryTransport,
    InMemoryTransportServer,
    createMemoryTransportPair,
} from "../../transport/memory.js";
import { SwarmServer } from "../../core/server.js";
import { SwarmClient } from "../../core/client.js";

async function main() {
    console.log("\nInMemoryTransport:");

    await test("pair delivers data bidirectionally", async () => {
        const [a, b] = createMemoryTransportPair();
        const received: { side: string; data: string }[] = [];

        a.onData((data) => received.push({ side: "a", data }));
        b.onData((data) => received.push({ side: "b", data }));

        a.write("hello from a");
        b.write("hello from b");

        assertEqual(received.length, 2, "2 messages received");
        assertEqual(received[0].side, "b", "a's write delivered to b");
        assertEqual(received[0].data, "hello from a", "correct data");
        assertEqual(received[1].side, "a", "b's write delivered to a");
        assertEqual(received[1].data, "hello from b", "correct data");
    });

    await test("connected is true initially, false after close", async () => {
        const [a, b] = createMemoryTransportPair();
        assert(a.connected, "a connected");
        assert(b.connected, "b connected");

        a.close();
        assert(!a.connected, "a disconnected");
        assert(!b.connected, "b also disconnected (peer close)");
    });

    await test("close fires close handlers on both sides", async () => {
        const [a, b] = createMemoryTransportPair();
        let aClosed = false;
        let bClosed = false;

        a.onClose(() => { aClosed = true; });
        b.onClose(() => { bClosed = true; });

        a.close();
        assert(aClosed, "a close handler fired");
        assert(bClosed, "b close handler fired (peer)");
    });

    await test("write after close is silently ignored", async () => {
        const [a, b] = createMemoryTransportPair();
        const received: string[] = [];
        b.onData((data) => received.push(data));

        a.close();
        a.write("should be ignored");
        assertEqual(received.length, 0, "no data after close");
    });

    await test("error injection fires error handlers", async () => {
        const [a, _] = createMemoryTransportPair();
        const errors: string[] = [];
        a.onError((err) => errors.push(err.message));

        a._injectError(new Error("test error"));
        assertEqual(errors.length, 1, "error handler called");
        assertEqual(errors[0], "test error", "correct error message");
    });

    await test("multiple data handlers all receive data", async () => {
        const [a, b] = createMemoryTransportPair();
        let count = 0;
        b.onData(() => count++);
        b.onData(() => count++);

        a.write("test");
        assertEqual(count, 2, "both handlers called");
    });

    console.log("\nInMemoryTransportServer:");

    await test("connect returns client transport, delivers server transport", async () => {
        const server = new InMemoryTransportServer();
        let serverTransport: any = null;

        server.onConnection((t) => { serverTransport = t; });
        await server.start();

        const clientTransport = server.connect();
        assert(serverTransport !== null, "server received connection");
        assert(clientTransport.connected, "client connected");
        assert(serverTransport.connected, "server connected");

        // Bidirectional communication works
        const fromClient: string[] = [];
        const fromServer: string[] = [];
        serverTransport.onData((d: string) => fromClient.push(d));
        clientTransport.onData((d: string) => fromServer.push(d));

        clientTransport.write("hi server");
        serverTransport.write("hi client");

        assertEqual(fromClient.length, 1, "server got data");
        assertEqual(fromClient[0], "hi server", "correct data");
        assertEqual(fromServer.length, 1, "client got data");
        assertEqual(fromServer[0], "hi client", "correct data");

        await server.stop();
    });

    await test("connect throws if server not running", async () => {
        const server = new InMemoryTransportServer();
        try {
            server.connect();
            assert(false, "should have thrown");
        } catch (err) {
            assert((err as Error).message.includes("not running"), "correct error");
        }
    });

    await test("connect throws after server stopped (T7)", async () => {
        const server = new InMemoryTransportServer();
        server.onConnection(() => {});
        await server.start();

        // Verify it works while running
        const t = server.connect();
        assert(t.connected, "connect works while running");

        await server.stop();

        // Should throw after stop
        try {
            server.connect();
            assert(false, "should have thrown after stop");
        } catch (err) {
            assert((err as Error).message.includes("not running"), "correct error after stop");
        }
    });

    console.log("\nSwarmServer + InMemoryTransport:");

    await test("server/client work with in-memory transport", async () => {
        const transportServer = new InMemoryTransportServer();
        const server = new SwarmServer(transportServer);
        await server.start();

        // Connect a client using in-memory transport
        const clientTransport = transportServer.connect();
        const client = new SwarmClient({ name: "test-agent", role: "agent", swarm: "s1" });
        await client.connectWithTransport(clientTransport);

        assert(client.connected, "client connected");
        assert(client.registered, "client registered");
        assertEqual(server.getClients().size, 1, "server has 1 client");

        client.disconnect();
        await server.stop();
    });

    await test("messaging works through in-memory transport", async () => {
        const transportServer = new InMemoryTransportServer();
        const server = new SwarmServer(transportServer);
        await server.start();

        const t1 = transportServer.connect();
        const t2 = transportServer.connect();
        const a1 = new SwarmClient({ name: "a1", role: "agent", swarm: "s1" });
        const a2 = new SwarmClient({ name: "a2", role: "agent", swarm: "s1" });
        await a1.connectWithTransport(t1);
        await a2.connectWithTransport(t2);

        const received: any[] = [];
        a2.on("message", (msg) => received.push(msg));

        a1.nudge("in-memory nudge");
        // In-memory transport is synchronous — no delay needed
        // But give event loop a tick for any async processing
        await delay(10);

        assertEqual(received.length, 1, "a2 received nudge");
        assertEqual(received[0].from.name, "a1", "from a1");
        assertEqual(received[0].message.reason, "in-memory nudge", "correct reason");

        a1.disconnect();
        a2.disconnect();
        await server.stop();
    });

    await test("routing works with in-memory transport — cross-swarm blocked", async () => {
        const transportServer = new InMemoryTransportServer();
        const server = new SwarmServer(transportServer);
        await server.start();

        const t1 = transportServer.connect();
        const t2 = transportServer.connect();
        const a1 = new SwarmClient({ name: "a1", role: "agent", swarm: "s1" });
        const b1 = new SwarmClient({ name: "b1", role: "agent", swarm: "s2" });
        await a1.connectWithTransport(t1);
        await b1.connectWithTransport(t2);

        const received: any[] = [];
        b1.on("message", (msg) => received.push(msg));

        a1.nudge("should not arrive");
        await delay(10);

        assertEqual(received.length, 0, "b1 received nothing (different swarm)");

        a1.disconnect();
        b1.disconnect();
        await server.stop();
    });

    await test("full hierarchy with in-memory transport", async () => {
        const transportServer = new InMemoryTransportServer();
        const server = new SwarmServer(transportServer);
        await server.start();

        const queen = new SwarmClient({ name: "queen", role: "queen" });
        const coord = new SwarmClient({ name: "coord-a", role: "coordinator", swarm: "s1" });
        const a1 = new SwarmClient({ name: "a1", role: "agent", swarm: "s1" });
        const a2 = new SwarmClient({ name: "a2", role: "agent", swarm: "s1" });

        await queen.connectWithTransport(transportServer.connect());
        await coord.connectWithTransport(transportServer.connect());
        await a1.connectWithTransport(transportServer.connect());
        await a2.connectWithTransport(transportServer.connect());

        assertEqual(server.getClients().size, 4, "4 clients");

        // Agent nudge → coordinator + sibling, not queen
        const queenMsgs: any[] = [];
        const coordMsgs: any[] = [];
        const a2Msgs: any[] = [];
        queen.on("message", (m) => queenMsgs.push(m));
        coord.on("message", (m) => coordMsgs.push(m));
        a2.on("message", (m) => a2Msgs.push(m));

        a1.nudge("agent nudge");
        await delay(10);

        assertEqual(coordMsgs.length, 1, "coord received agent nudge");
        assertEqual(a2Msgs.length, 1, "a2 received sibling nudge");
        assertEqual(queenMsgs.length, 0, "queen did NOT receive agent nudge");

        // Coordinator nudge → queen + own agents + other coordinators
        coordMsgs.length = 0;
        a2Msgs.length = 0;
        const a1Msgs: any[] = [];
        a1.on("message", (m) => a1Msgs.push(m));

        coord.nudge("coord nudge");
        await delay(10);

        assertEqual(queenMsgs.length, 1, "queen received coord nudge");
        assertEqual(a1Msgs.length, 1, "a1 received coord nudge");
        assertEqual(a2Msgs.length, 1, "a2 received coord nudge");

        queen.disconnect();
        coord.disconnect();
        a1.disconnect();
        a2.disconnect();
        await server.stop();
    });

    await test("instruct targeting works with in-memory transport", async () => {
        const transportServer = new InMemoryTransportServer();
        const server = new SwarmServer(transportServer);
        await server.start();

        const queen = new SwarmClient({ name: "queen", role: "queen" });
        const a1 = new SwarmClient({ name: "a1", role: "agent", swarm: "s1" });
        const a2 = new SwarmClient({ name: "a2", role: "agent", swarm: "s1" });

        await queen.connectWithTransport(transportServer.connect());
        await a1.connectWithTransport(transportServer.connect());
        await a2.connectWithTransport(transportServer.connect());

        const a1Msgs: any[] = [];
        const a2Msgs: any[] = [];
        a1.on("message", (m) => a1Msgs.push(m));
        a2.on("message", (m) => a2Msgs.push(m));

        queen.instruct("focus on auth", "a1");
        await delay(10);

        assertEqual(a1Msgs.length, 1, "a1 received targeted instruct");
        assertEqual(a1Msgs[0].message.instruction, "focus on auth", "correct instruction");
        assertEqual(a2Msgs.length, 0, "a2 did NOT receive (targeted to a1)");

        queen.disconnect();
        a1.disconnect();
        a2.disconnect();
        await server.stop();
    });

    await test("disconnect removes client with in-memory transport", async () => {
        const transportServer = new InMemoryTransportServer();
        let disconnectedName = "";
        const server = new SwarmServer(transportServer, {
            onDisconnect: (client) => { disconnectedName = client.name; },
        });
        await server.start();

        const client = new SwarmClient({ name: "temp", role: "agent", swarm: "s1" });
        await client.connectWithTransport(transportServer.connect());
        assertEqual(server.getClients().size, 1, "1 client");

        client.disconnect();
        await delay(10);

        assertEqual(server.getClients().size, 0, "0 clients after disconnect");
        assertEqual(disconnectedName, "temp", "disconnect handler called");

        await server.stop();
    });
}

main().then(() => summarize());
