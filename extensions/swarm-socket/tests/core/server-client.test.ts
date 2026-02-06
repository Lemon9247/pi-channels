/**
 * Server + Client integration tests: connect, register, message routing
 */

import * as fs from "node:fs";
import { test, assert, assertEqual, tmpSocketPath, delay, summarize } from "../helpers.js";
import { SwarmServer } from "../../core/server.js";
import { SwarmClient } from "../../core/client.js";
import { UnixTransportServer } from "../../transport/unix-socket.js";

async function main() {
    console.log("\nServer + Client Integration:");

    await test("server starts and stops cleanly", async () => {
        const sock = tmpSocketPath();
        const server = new SwarmServer(new UnixTransportServer(sock));
        await server.start();
        assert(fs.existsSync(sock), "socket file exists");
        await server.stop();
        assert(!fs.existsSync(sock), "socket file cleaned up");
    });

    await test("client connects and registers", async () => {
        const sock = tmpSocketPath();
        const server = new SwarmServer(new UnixTransportServer(sock));
        await server.start();

        const client = new SwarmClient({ name: "queen", role: "queen" });
        await client.connect(sock);
        assert(client.connected, "connected");
        assert(client.registered, "registered");
        assertEqual(server.getClients().size, 1, "server has 1 client");

        client.disconnect();
        await server.stop();
    });

    await test("duplicate name rejected", async () => {
        const sock = tmpSocketPath();
        const server = new SwarmServer(new UnixTransportServer(sock));
        await server.start();

        const c1 = new SwarmClient({ name: "agent-a", role: "agent", swarm: "s1" });
        await c1.connect(sock);

        const c2 = new SwarmClient({ name: "agent-a", role: "agent", swarm: "s1" });
        try {
            await c2.connect(sock);
            assert(false, "should have thrown");
        } catch (err) {
            assert((err as Error).message.includes("Duplicate"), "duplicate error message");
        }

        c1.disconnect();
        c2.disconnect();
        await server.stop();
    });

    await test("nudge delivered within same swarm", async () => {
        const sock = tmpSocketPath();
        const server = new SwarmServer(new UnixTransportServer(sock));
        await server.start();

        const a1 = new SwarmClient({ name: "a1", role: "agent", swarm: "s1" });
        const a2 = new SwarmClient({ name: "a2", role: "agent", swarm: "s1" });
        await a1.connect(sock);
        await a2.connect(sock);

        const received: any[] = [];
        a2.on("message", (msg) => received.push(msg));

        a1.nudge("found something");
        await delay(50);

        assertEqual(received.length, 1, "a2 received 1 message");
        assertEqual(received[0].from, "a1", "from a1");
        assertEqual(received[0].message.type, "nudge", "nudge type");
        assertEqual(received[0].message.reason, "found something", "reason");

        a1.disconnect();
        a2.disconnect();
        await server.stop();
    });

    await test("nudge NOT delivered across swarms for agents", async () => {
        const sock = tmpSocketPath();
        const server = new SwarmServer(new UnixTransportServer(sock));
        await server.start();

        const a1 = new SwarmClient({ name: "a1", role: "agent", swarm: "s1" });
        const b1 = new SwarmClient({ name: "b1", role: "agent", swarm: "s2" });
        await a1.connect(sock);
        await b1.connect(sock);

        const received: any[] = [];
        b1.on("message", (msg) => received.push(msg));

        a1.nudge("found something");
        await delay(50);

        assertEqual(received.length, 0, "b1 received nothing (different swarm)");

        a1.disconnect();
        b1.disconnect();
        await server.stop();
    });

    await test("agent can message own coordinator", async () => {
        const sock = tmpSocketPath();
        const server = new SwarmServer(new UnixTransportServer(sock));
        await server.start();

        const coord = new SwarmClient({ name: "coord-a", role: "coordinator", swarm: "s1" });
        const a1 = new SwarmClient({ name: "a1", role: "agent", swarm: "s1" });
        await coord.connect(sock);
        await a1.connect(sock);

        const received: any[] = [];
        coord.on("message", (msg) => received.push(msg));

        a1.blocker("stuck on X");
        await delay(50);

        assertEqual(received.length, 1, "coordinator received blocker");
        assertEqual(received[0].message.type, "blocker", "blocker type");

        coord.disconnect();
        a1.disconnect();
        await server.stop();
    });

    await test("agent cannot message coordinator of different swarm", async () => {
        const sock = tmpSocketPath();
        const server = new SwarmServer(new UnixTransportServer(sock));
        await server.start();

        const coordB = new SwarmClient({ name: "coord-b", role: "coordinator", swarm: "s2" });
        const a1 = new SwarmClient({ name: "a1", role: "agent", swarm: "s1" });
        await coordB.connect(sock);
        await a1.connect(sock);

        const received: any[] = [];
        coordB.on("message", (msg) => received.push(msg));

        a1.nudge("test");
        await delay(50);

        assertEqual(received.length, 0, "coord-b received nothing");

        coordB.disconnect();
        a1.disconnect();
        await server.stop();
    });

    await test("coordinator can message other coordinators", async () => {
        const sock = tmpSocketPath();
        const server = new SwarmServer(new UnixTransportServer(sock));
        await server.start();

        const coordA = new SwarmClient({ name: "coord-a", role: "coordinator", swarm: "s1" });
        const coordB = new SwarmClient({ name: "coord-b", role: "coordinator", swarm: "s2" });
        await coordA.connect(sock);
        await coordB.connect(sock);

        const received: any[] = [];
        coordB.on("message", (msg) => received.push(msg));

        coordA.nudge("cross-swarm update");
        await delay(50);

        assertEqual(received.length, 1, "coord-b received from coord-a");
        assertEqual(received[0].message.reason, "cross-swarm update", "reason");

        coordA.disconnect();
        coordB.disconnect();
        await server.stop();
    });

    await test("coordinator nudge does NOT reach agents in other swarm", async () => {
        const sock = tmpSocketPath();
        const server = new SwarmServer(new UnixTransportServer(sock));
        await server.start();

        const coordA = new SwarmClient({ name: "coord-a", role: "coordinator", swarm: "s1" });
        const b1 = new SwarmClient({ name: "b1", role: "agent", swarm: "s2" });
        await coordA.connect(sock);
        await b1.connect(sock);

        const received: any[] = [];
        b1.on("message", (msg) => received.push(msg));

        coordA.nudge("cross-swarm");
        await delay(50);

        assertEqual(received.length, 0, "b1 received nothing (not coord-a's agent)");

        coordA.disconnect();
        b1.disconnect();
        await server.stop();
    });

    await test("queen can message anyone", async () => {
        const sock = tmpSocketPath();
        const server = new SwarmServer(new UnixTransportServer(sock));
        await server.start();

        const queen = new SwarmClient({ name: "queen", role: "queen" });
        const coordA = new SwarmClient({ name: "coord-a", role: "coordinator", swarm: "s1" });
        const a1 = new SwarmClient({ name: "a1", role: "agent", swarm: "s1" });
        const b1 = new SwarmClient({ name: "b1", role: "agent", swarm: "s2" });
        await queen.connect(sock);
        await coordA.connect(sock);
        await a1.connect(sock);
        await b1.connect(sock);

        const receivedCoord: any[] = [];
        const receivedA1: any[] = [];
        const receivedB1: any[] = [];
        coordA.on("message", (msg) => receivedCoord.push(msg));
        a1.on("message", (msg) => receivedA1.push(msg));
        b1.on("message", (msg) => receivedB1.push(msg));

        queen.nudge("queen broadcast");
        await delay(50);

        assertEqual(receivedCoord.length, 1, "coord received");
        assertEqual(receivedA1.length, 1, "a1 received");
        assertEqual(receivedB1.length, 1, "b1 received");

        queen.disconnect();
        coordA.disconnect();
        a1.disconnect();
        b1.disconnect();
        await server.stop();
    });

    await test("instruct targets specific agent", async () => {
        const sock = tmpSocketPath();
        const server = new SwarmServer(new UnixTransportServer(sock));
        await server.start();

        const queen = new SwarmClient({ name: "queen", role: "queen" });
        const a1 = new SwarmClient({ name: "a1", role: "agent", swarm: "s1" });
        const a2 = new SwarmClient({ name: "a2", role: "agent", swarm: "s1" });
        await queen.connect(sock);
        await a1.connect(sock);
        await a2.connect(sock);

        const receivedA1: any[] = [];
        const receivedA2: any[] = [];
        a1.on("message", (msg) => receivedA1.push(msg));
        a2.on("message", (msg) => receivedA2.push(msg));

        queen.instruct("focus on auth module", "a1");
        await delay(50);

        assertEqual(receivedA1.length, 1, "a1 received instruct");
        assertEqual(receivedA1[0].message.instruction, "focus on auth module", "instruction content");
        assertEqual(receivedA2.length, 0, "a2 did NOT receive (targeted to a1)");

        queen.disconnect();
        a1.disconnect();
        a2.disconnect();
        await server.stop();
    });

    await test("instruct targets swarm", async () => {
        const sock = tmpSocketPath();
        const server = new SwarmServer(new UnixTransportServer(sock));
        await server.start();

        const queen = new SwarmClient({ name: "queen", role: "queen" });
        const a1 = new SwarmClient({ name: "a1", role: "agent", swarm: "s1" });
        const a2 = new SwarmClient({ name: "a2", role: "agent", swarm: "s1" });
        const b1 = new SwarmClient({ name: "b1", role: "agent", swarm: "s2" });
        await queen.connect(sock);
        await a1.connect(sock);
        await a2.connect(sock);
        await b1.connect(sock);

        const receivedA1: any[] = [];
        const receivedA2: any[] = [];
        const receivedB1: any[] = [];
        a1.on("message", (msg) => receivedA1.push(msg));
        a2.on("message", (msg) => receivedA2.push(msg));
        b1.on("message", (msg) => receivedB1.push(msg));

        queen.instruct("wrap up", undefined, "s1");
        await delay(50);

        assertEqual(receivedA1.length, 1, "a1 received");
        assertEqual(receivedA2.length, 1, "a2 received");
        assertEqual(receivedB1.length, 0, "b1 did NOT receive (swarm s2)");

        queen.disconnect();
        a1.disconnect();
        a2.disconnect();
        b1.disconnect();
        await server.stop();
    });

    await test("instruct respects routing — agent cannot instruct other swarm", async () => {
        const sock = tmpSocketPath();
        const server = new SwarmServer(new UnixTransportServer(sock));
        await server.start();

        const a1 = new SwarmClient({ name: "a1", role: "agent", swarm: "s1" });
        const b1 = new SwarmClient({ name: "b1", role: "agent", swarm: "s2" });
        await a1.connect(sock);
        await b1.connect(sock);

        const receivedB1: any[] = [];
        const errors: string[] = [];
        b1.on("message", (msg) => receivedB1.push(msg));
        a1.on("error", (msg) => errors.push(msg));

        a1.instruct("do something", "b1");
        await delay(50);

        assertEqual(receivedB1.length, 0, "b1 did NOT receive (cross-swarm agent)");
        assertEqual(errors.length, 1, "a1 got error about no valid recipients");

        a1.disconnect();
        b1.disconnect();
        await server.stop();
    });

    await test("disconnect removes client from registry", async () => {
        const sock = tmpSocketPath();
        let disconnectedName = "";
        const server = new SwarmServer(new UnixTransportServer(sock), {
            onDisconnect: (client) => {
                disconnectedName = client.name;
            },
        });
        await server.start();

        const client = new SwarmClient({ name: "temp", role: "agent", swarm: "s1" });
        await client.connect(sock);
        assertEqual(server.getClients().size, 1, "1 client registered");

        client.disconnect();
        await delay(50);

        assertEqual(server.getClients().size, 0, "0 clients after disconnect");
        assertEqual(disconnectedName, "temp", "disconnect handler called");

        await server.stop();
    });

    await test("done message delivered to coordinator (not queen — agent can't reach queen)", async () => {
        const sock = tmpSocketPath();
        const server = new SwarmServer(new UnixTransportServer(sock));
        await server.start();

        const queen = new SwarmClient({ name: "queen", role: "queen" });
        const coord = new SwarmClient({ name: "coord-a", role: "coordinator", swarm: "s1" });
        const a1 = new SwarmClient({ name: "a1", role: "agent", swarm: "s1" });
        await queen.connect(sock);
        await coord.connect(sock);
        await a1.connect(sock);

        const receivedQueen: any[] = [];
        const receivedCoord: any[] = [];
        queen.on("message", (msg) => receivedQueen.push(msg));
        coord.on("message", (msg) => receivedCoord.push(msg));

        a1.done("task complete");
        await delay(50);

        assertEqual(receivedCoord.length, 1, "coordinator received done");
        assertEqual(receivedCoord[0].message.summary, "task complete", "summary");
        assertEqual(receivedQueen.length, 0, "queen did NOT receive (agents can't reach queen)");

        queen.disconnect();
        coord.disconnect();
        a1.disconnect();
        await server.stop();
    });

    await test("full hierarchy: queen + 2 coordinators + 4 agents", async () => {
        const sock = tmpSocketPath();
        const server = new SwarmServer(new UnixTransportServer(sock));
        await server.start();

        const queen = new SwarmClient({ name: "queen", role: "queen" });
        const coordA = new SwarmClient({ name: "coord-a", role: "coordinator", swarm: "s1" });
        const coordB = new SwarmClient({ name: "coord-b", role: "coordinator", swarm: "s2" });
        const a1 = new SwarmClient({ name: "a1", role: "agent", swarm: "s1" });
        const a2 = new SwarmClient({ name: "a2", role: "agent", swarm: "s1" });
        const b1 = new SwarmClient({ name: "b1", role: "agent", swarm: "s2" });
        const b2 = new SwarmClient({ name: "b2", role: "agent", swarm: "s2" });

        await queen.connect(sock);
        await coordA.connect(sock);
        await coordB.connect(sock);
        await a1.connect(sock);
        await a2.connect(sock);
        await b1.connect(sock);
        await b2.connect(sock);

        assertEqual(server.getClients().size, 7, "7 clients");

        const msgs: Record<string, any[]> = {
            queen: [], "coord-a": [], "coord-b": [],
            a1: [], a2: [], b1: [], b2: [],
        };
        queen.on("message", (m) => msgs.queen.push(m));
        coordA.on("message", (m) => msgs["coord-a"].push(m));
        coordB.on("message", (m) => msgs["coord-b"].push(m));
        a1.on("message", (m) => msgs.a1.push(m));
        a2.on("message", (m) => msgs.a2.push(m));
        b1.on("message", (m) => msgs.b1.push(m));
        b2.on("message", (m) => msgs.b2.push(m));

        a1.nudge("agent-level nudge");
        await delay(50);

        assertEqual(msgs.a2.length, 1, "a2 got a1's nudge");
        assertEqual(msgs["coord-a"].length, 1, "coord-a got a1's nudge");
        assertEqual(msgs.queen.length, 0, "queen did NOT get agent nudge");
        assertEqual(msgs["coord-b"].length, 0, "coord-b did NOT get agent nudge");
        assertEqual(msgs.b1.length, 0, "b1 did NOT get agent nudge");
        assertEqual(msgs.b2.length, 0, "b2 did NOT get agent nudge");

        for (const k of Object.keys(msgs)) msgs[k] = [];

        coordA.nudge("coordinator nudge");
        await delay(50);

        assertEqual(msgs.queen.length, 1, "queen got coord nudge");
        assertEqual(msgs["coord-b"].length, 1, "coord-b got coord nudge");
        assertEqual(msgs.a1.length, 1, "a1 got own coordinator's nudge");
        assertEqual(msgs.a2.length, 1, "a2 got own coordinator's nudge");
        assertEqual(msgs.b1.length, 0, "b1 did NOT get coord-a's nudge");
        assertEqual(msgs.b2.length, 0, "b2 did NOT get coord-a's nudge");

        for (const c of [queen, coordA, coordB, a1, a2, b1, b2]) c.disconnect();
        await server.stop();
    });
}

main().then(() => summarize());
