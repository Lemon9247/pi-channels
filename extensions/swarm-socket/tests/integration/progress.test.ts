/**
 * Progress message integration tests (T5, M5).
 *
 * T5: Tests that progress messages flow correctly through the client+server layer,
 *     covering what the hive_progress tool does (calls client.progress()).
 *
 * M5: Tests progress with `to` and `swarm` targeting fields.
 */

import { test, assert, assertEqual, tmpSocketPath, delay, summarize } from "../helpers.js";
import { SwarmServer } from "../../core/server.js";
import { SwarmClient } from "../../core/client.js";
import { UnixTransportServer } from "../../transport/unix-socket.js";
import type { RelayedMessage, ProgressMessage } from "../../transport/protocol.js";

async function main() {
    console.log("\nProgress Integration (T5):");

    await test("client.progress() sends all fields through to coordinator", async () => {
        const sock = tmpSocketPath();
        const server = new SwarmServer(new UnixTransportServer(sock));
        await server.start();

        const coord = new SwarmClient({ name: "coord", role: "coordinator", swarm: "s1" });
        const a1 = new SwarmClient({ name: "a1", role: "agent", swarm: "s1" });
        await coord.connect(sock);
        await a1.connect(sock);

        const received: RelayedMessage[] = [];
        coord.on("message", (msg) => received.push(msg));

        a1.progress({ phase: "running tests", percent: 75, detail: "15/20 tests passed" });
        await delay(50);

        assertEqual(received.length, 1, "coord received progress");
        const progress = received[0].message as ProgressMessage;
        assertEqual(progress.type, "progress", "type is progress");
        assertEqual(progress.phase, "running tests", "phase");
        assertEqual(progress.percent, 75, "percent");
        assertEqual(progress.detail, "15/20 tests passed", "detail");
        // Verify sender identity
        assertEqual(received[0].from.name, "a1", "from a1");
        assertEqual(received[0].from.role, "agent", "sender is agent");
    });

    await test("client.progress() with only phase (minimal)", async () => {
        const sock = tmpSocketPath();
        const server = new SwarmServer(new UnixTransportServer(sock));
        await server.start();

        const coord = new SwarmClient({ name: "coord", role: "coordinator", swarm: "s1" });
        const a1 = new SwarmClient({ name: "a1", role: "agent", swarm: "s1" });
        await coord.connect(sock);
        await a1.connect(sock);

        const received: RelayedMessage[] = [];
        coord.on("message", (msg) => received.push(msg));

        a1.progress({ phase: "writing report" });
        await delay(50);

        assertEqual(received.length, 1, "received progress");
        const progress = received[0].message as ProgressMessage;
        assertEqual(progress.phase, "writing report", "phase");
        assertEqual(progress.percent, undefined, "no percent");
        assertEqual(progress.detail, undefined, "no detail");

        coord.disconnect();
        a1.disconnect();
        await server.stop();
    });

    await test("client.progress() with empty options sends valid progress", async () => {
        const sock = tmpSocketPath();
        const server = new SwarmServer(new UnixTransportServer(sock));
        await server.start();

        const coord = new SwarmClient({ name: "coord", role: "coordinator", swarm: "s1" });
        const a1 = new SwarmClient({ name: "a1", role: "agent", swarm: "s1" });
        await coord.connect(sock);
        await a1.connect(sock);

        const received: RelayedMessage[] = [];
        coord.on("message", (msg) => received.push(msg));

        a1.progress({});
        await delay(50);

        assertEqual(received.length, 1, "received empty progress");
        assertEqual(received[0].message.type, "progress", "type is progress");

        coord.disconnect();
        a1.disconnect();
        await server.stop();
    });

    await test("multiple progress updates arrive in order", async () => {
        const sock = tmpSocketPath();
        const server = new SwarmServer(new UnixTransportServer(sock));
        await server.start();

        const coord = new SwarmClient({ name: "coord", role: "coordinator", swarm: "s1" });
        const a1 = new SwarmClient({ name: "a1", role: "agent", swarm: "s1" });
        await coord.connect(sock);
        await a1.connect(sock);

        const received: RelayedMessage[] = [];
        coord.on("message", (msg) => received.push(msg));

        a1.progress({ phase: "reading files", percent: 0, detail: "starting" });
        a1.progress({ phase: "reading files", percent: 50, detail: "halfway" });
        a1.progress({ phase: "writing report", percent: 100, detail: "done" });
        await delay(50);

        assertEqual(received.length, 3, "3 progress messages");
        assertEqual((received[0].message as ProgressMessage).percent, 0, "first 0%");
        assertEqual((received[1].message as ProgressMessage).percent, 50, "second 50%");
        assertEqual((received[2].message as ProgressMessage).percent, 100, "third 100%");
        assertEqual((received[2].message as ProgressMessage).phase, "writing report", "third phase changed");

        coord.disconnect();
        a1.disconnect();
        await server.stop();
    });

    console.log("\nProgress Targeting (M5):");

    await test("progress with 'to' field targets specific agent", async () => {
        const sock = tmpSocketPath();
        const server = new SwarmServer(new UnixTransportServer(sock));
        await server.start();

        const coord = new SwarmClient({ name: "coord", role: "coordinator", swarm: "s1" });
        const a1 = new SwarmClient({ name: "a1", role: "agent", swarm: "s1" });
        const a2 = new SwarmClient({ name: "a2", role: "agent", swarm: "s1" });
        await coord.connect(sock);
        await a1.connect(sock);
        await a2.connect(sock);

        const coordReceived: RelayedMessage[] = [];
        const a2Received: RelayedMessage[] = [];
        coord.on("message", (msg) => coordReceived.push(msg));
        a2.on("message", (msg) => a2Received.push(msg));

        // a1 sends progress targeted to coord only
        a1.send({ type: "progress", phase: "reading", percent: 50, to: "coord" });
        await delay(50);

        assertEqual(coordReceived.length, 1, "coord received targeted progress");
        assertEqual(a2Received.length, 0, "a2 did NOT receive targeted progress");
        assertEqual((coordReceived[0].message as ProgressMessage).phase, "reading", "phase correct");

        coord.disconnect();
        a1.disconnect();
        a2.disconnect();
        await server.stop();
    });

    await test("progress with 'swarm' field targets swarm members", async () => {
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

        const a1Received: RelayedMessage[] = [];
        const a2Received: RelayedMessage[] = [];
        const b1Received: RelayedMessage[] = [];
        a1.on("message", (msg) => a1Received.push(msg));
        a2.on("message", (msg) => a2Received.push(msg));
        b1.on("message", (msg) => b1Received.push(msg));

        // Queen sends progress targeted to swarm s1
        queen.send({ type: "progress", phase: "deploying", percent: 90, swarm: "s1" });
        await delay(50);

        assertEqual(a1Received.length, 1, "a1 received swarm progress");
        assertEqual(a2Received.length, 1, "a2 received swarm progress");
        assertEqual(b1Received.length, 0, "b1 did NOT receive (different swarm)");

        queen.disconnect();
        a1.disconnect();
        a2.disconnect();
        b1.disconnect();
        await server.stop();
    });

    await test("progress from disconnected client throws", async () => {
        const a1 = new SwarmClient({ name: "a1", role: "agent", swarm: "s1" });

        try {
            a1.progress({ phase: "test" });
            assert(false, "should have thrown");
        } catch (err) {
            assert((err as Error).message.includes("Not connected"), "throws not connected");
        }
    });
}

main().then(() => summarize());
