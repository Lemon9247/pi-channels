/**
 * Relay integration tests: BACKWARD COMPATIBILITY — old JSON-in-nudge format.
 *
 * These tests verify the OLD relay format where coordinator encodes sub-agent events
 * as JSON strings inside nudge reasons (the `{ sub: true, ... }` format parsed by
 * `parseSubRelay`). This format is deprecated but kept for backward compatibility.
 *
 * For tests of the NEW first-class relay format (`client.relay()` / RelayMessage),
 * see `tests/integration/relay-v2.test.ts` and `tests/integration/targeted-messaging.test.ts`.
 */

import { test, assert, assertEqual, tmpSocketPath, delay, summarize } from "../helpers.js";
import { SwarmServer } from "../../core/server.js";
import { SwarmClient } from "../../core/client.js";
import { UnixTransportServer } from "../../transport/unix-socket.js";
import { parseSubRelay } from "../../core/state.js";

async function main() {
    console.log("\nRelay Integration (backward compat — old JSON-in-nudge format):");

    await test("coordinator relays sub-agent registration to queen via JSON nudge", async () => {
        const sock = tmpSocketPath();
        const server = new SwarmServer(new UnixTransportServer(sock));
        await server.start();

        const queen = new SwarmClient({ name: "queen", role: "queen" });
        const coord = new SwarmClient({ name: "coord-a", role: "coordinator", swarm: "s1" });
        await queen.connect(sock);
        await coord.connect(sock);

        const received: any[] = [];
        queen.on("message", (msg) => received.push(msg));

        const relay = { sub: true, type: "register", name: "a1", role: "agent", swarm: "s1", code: "0.1.1" };
        coord.nudge(JSON.stringify(relay));
        await delay(50);

        assertEqual(received.length, 1, "queen received relay nudge");
        const parsed = parseSubRelay(received[0].message.reason);
        assert(parsed !== null, "parseable as relay");
        assertEqual(parsed!.type, "register", "relay type");
        assertEqual(parsed!.name, "a1", "relay agent name");
        assertEqual(parsed!.code, "0.1.1", "relay code");

        queen.disconnect();
        coord.disconnect();
        await server.stop();
    });

    await test("coordinator relays done + blocked to queen", async () => {
        const sock = tmpSocketPath();
        const server = new SwarmServer(new UnixTransportServer(sock));
        await server.start();

        const queen = new SwarmClient({ name: "queen", role: "queen" });
        const coord = new SwarmClient({ name: "coord-a", role: "coordinator", swarm: "s1" });
        await queen.connect(sock);
        await coord.connect(sock);

        const received: any[] = [];
        queen.on("message", (msg) => received.push(msg));

        coord.nudge(JSON.stringify({ sub: true, type: "done", name: "a1", role: "agent", swarm: "s1", code: "0.1.1", summary: "task complete" }));
        coord.nudge(JSON.stringify({ sub: true, type: "blocked", name: "a2", role: "agent", swarm: "s1", code: "0.1.2", description: "stuck" }));
        await delay(50);

        assertEqual(received.length, 2, "queen received 2 relays");
        const done = parseSubRelay(received[0].message.reason)!;
        assertEqual(done.type, "done", "first is done");
        assertEqual(done.summary, "task complete", "done summary");
        const blocked = parseSubRelay(received[1].message.reason)!;
        assertEqual(blocked.type, "blocked", "second is blocked");
        assertEqual(blocked.description, "stuck", "blocked description");

        queen.disconnect();
        coord.disconnect();
        await server.stop();
    });

    await test("deep relay: sub-coordinator → coordinator → queen (passthrough)", async () => {
        const sock = tmpSocketPath();
        const server = new SwarmServer(new UnixTransportServer(sock));
        await server.start();

        const queen = new SwarmClient({ name: "queen", role: "queen" });
        const coord = new SwarmClient({ name: "coord-a", role: "coordinator", swarm: "s1" });
        const subCoord = new SwarmClient({ name: "sub-coord", role: "coordinator", swarm: "s1" });
        await queen.connect(sock);
        await coord.connect(sock);
        await subCoord.connect(sock);

        const queenReceived: any[] = [];
        const coordReceived: any[] = [];
        queen.on("message", (msg) => queenReceived.push(msg));
        coord.on("message", (msg) => coordReceived.push(msg));

        const relay = { sub: true, type: "register", name: "deep-agent", role: "agent", swarm: "s1", code: "0.1.1.1" };
        subCoord.nudge(JSON.stringify(relay));
        await delay(50);

        assert(queenReceived.length >= 1, "queen received relay");
        assert(coordReceived.length >= 1, "coord received relay");

        const queenRelay = parseSubRelay(queenReceived[0].message.reason)!;
        assertEqual(queenRelay.name, "deep-agent", "queen sees deep agent");
        assertEqual(queenRelay.code, "0.1.1.1", "queen sees deep code");

        queen.disconnect();
        coord.disconnect();
        subCoord.disconnect();
        await server.stop();
    });
}

main().then(() => summarize());
