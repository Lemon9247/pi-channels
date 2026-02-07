/**
 * First-class relay integration tests (T1).
 *
 * Tests the NEW relay format using `client.relay()` which sends a RelayMessage
 * with a RelayEvent payload. This is the P2C replacement for the old JSON-in-nudge
 * format tested in `relay.test.ts`.
 *
 * Verifies:
 * - relay(register) arrives at queen and contains correct fields
 * - relay(done) with summary arrives correctly
 * - relay(blocked) arrives correctly
 * - relay(disconnected) arrives correctly
 * - Deep relay: sub-coordinator → coordinator → queen
 * - Mix of old JSON-in-nudge and new relay format in same session
 */

import { test, assert, assertEqual, tmpSocketPath, delay, summarize } from "../helpers.js";
import { SwarmServer } from "../../core/server.js";
import { SwarmClient } from "../../core/client.js";
import { UnixTransportServer } from "../../transport/unix-socket.js";
import { parseSubRelay } from "../../core/state.js";
import type { RelayedMessage, RelayMessage, NudgeMessage } from "../../transport/protocol.js";

async function main() {
    console.log("\nFirst-Class Relay (v2):");

    await test("relay(register) arrives at queen with correct fields", async () => {
        const sock = tmpSocketPath();
        const server = new SwarmServer(new UnixTransportServer(sock));
        await server.start();

        const queen = new SwarmClient({ name: "queen", role: "queen" });
        const coord = new SwarmClient({ name: "coord-a", role: "coordinator", swarm: "s1" });
        await queen.connect(sock);
        await coord.connect(sock);

        const received: RelayedMessage[] = [];
        queen.on("message", (msg) => received.push(msg));

        coord.relay({
            event: "register",
            name: "agent-x1",
            role: "agent",
            swarm: "s1",
            code: "0.1.1",
        });
        await delay(50);

        assertEqual(received.length, 1, "queen received relay");
        const relayMsg = received[0].message as RelayMessage;
        assertEqual(relayMsg.type, "relay", "message type is relay");
        assertEqual(relayMsg.relay.event, "register", "event is register");
        assertEqual(relayMsg.relay.name, "agent-x1", "agent name");
        assertEqual(relayMsg.relay.role, "agent", "agent role");
        assertEqual(relayMsg.relay.swarm, "s1", "swarm");
        assertEqual(relayMsg.relay.code, "0.1.1", "hierarchical code");
        // Verify sender identity
        assertEqual(received[0].from.name, "coord-a", "from coordinator");
        assertEqual(received[0].from.role, "coordinator", "sender role");

        queen.disconnect();
        coord.disconnect();
        await server.stop();
    });

    await test("relay(done) with summary arrives correctly", async () => {
        const sock = tmpSocketPath();
        const server = new SwarmServer(new UnixTransportServer(sock));
        await server.start();

        const queen = new SwarmClient({ name: "queen", role: "queen" });
        const coord = new SwarmClient({ name: "coord-a", role: "coordinator", swarm: "s1" });
        await queen.connect(sock);
        await coord.connect(sock);

        const received: RelayedMessage[] = [];
        queen.on("message", (msg) => received.push(msg));

        coord.relay({
            event: "done",
            name: "agent-a1",
            role: "agent",
            swarm: "s1",
            code: "0.1.1",
            summary: "finished analyzing protocol types",
        });
        await delay(50);

        assertEqual(received.length, 1, "queen received done relay");
        const relayMsg = received[0].message as RelayMessage;
        assertEqual(relayMsg.relay.event, "done", "event is done");
        assertEqual(relayMsg.relay.name, "agent-a1", "agent name");
        assertEqual(relayMsg.relay.summary, "finished analyzing protocol types", "summary preserved");

        queen.disconnect();
        coord.disconnect();
        await server.stop();
    });

    await test("relay(blocked) with description arrives correctly", async () => {
        const sock = tmpSocketPath();
        const server = new SwarmServer(new UnixTransportServer(sock));
        await server.start();

        const queen = new SwarmClient({ name: "queen", role: "queen" });
        const coord = new SwarmClient({ name: "coord-b", role: "coordinator", swarm: "s2" });
        await queen.connect(sock);
        await coord.connect(sock);

        const received: RelayedMessage[] = [];
        queen.on("message", (msg) => received.push(msg));

        coord.relay({
            event: "blocked",
            name: "agent-b1",
            role: "agent",
            swarm: "s2",
            code: "0.2.1",
            description: "missing API key for external service",
        });
        await delay(50);

        assertEqual(received.length, 1, "queen received blocked relay");
        const relayMsg = received[0].message as RelayMessage;
        assertEqual(relayMsg.relay.event, "blocked", "event is blocked");
        assertEqual(relayMsg.relay.description, "missing API key for external service", "description preserved");

        queen.disconnect();
        coord.disconnect();
        await server.stop();
    });

    await test("relay(disconnected) arrives correctly", async () => {
        const sock = tmpSocketPath();
        const server = new SwarmServer(new UnixTransportServer(sock));
        await server.start();

        const queen = new SwarmClient({ name: "queen", role: "queen" });
        const coord = new SwarmClient({ name: "coord-a", role: "coordinator", swarm: "s1" });
        await queen.connect(sock);
        await coord.connect(sock);

        const received: RelayedMessage[] = [];
        queen.on("message", (msg) => received.push(msg));

        coord.relay({
            event: "disconnected",
            name: "agent-a2",
            role: "agent",
            swarm: "s1",
            code: "0.1.2",
        });
        await delay(50);

        assertEqual(received.length, 1, "queen received disconnected relay");
        const relayMsg = received[0].message as RelayMessage;
        assertEqual(relayMsg.relay.event, "disconnected", "event is disconnected");
        assertEqual(relayMsg.relay.name, "agent-a2", "agent name");

        queen.disconnect();
        coord.disconnect();
        await server.stop();
    });

    await test("deep relay: sub-coordinator relays via coordinator to queen", async () => {
        const sock = tmpSocketPath();
        const server = new SwarmServer(new UnixTransportServer(sock));
        await server.start();

        const queen = new SwarmClient({ name: "queen", role: "queen" });
        const coord = new SwarmClient({ name: "coord-a", role: "coordinator", swarm: "s1" });
        const subCoord = new SwarmClient({ name: "sub-coord", role: "coordinator", swarm: "s1" });
        await queen.connect(sock);
        await coord.connect(sock);
        await subCoord.connect(sock);

        const queenReceived: RelayedMessage[] = [];
        const coordReceived: RelayedMessage[] = [];
        queen.on("message", (msg) => queenReceived.push(msg));
        coord.on("message", (msg) => coordReceived.push(msg));

        subCoord.relay({
            event: "register",
            name: "deep-agent",
            role: "agent",
            swarm: "s1",
            code: "0.1.1.1",
        });
        await delay(50);

        // Both queen and coord should receive the relay
        assert(queenReceived.length >= 1, "queen received deep relay");
        assert(coordReceived.length >= 1, "coord received deep relay");

        const queenRelay = queenReceived[0].message as RelayMessage;
        assertEqual(queenRelay.relay.name, "deep-agent", "queen sees deep agent");
        assertEqual(queenRelay.relay.code, "0.1.1.1", "queen sees deep code");

        queen.disconnect();
        coord.disconnect();
        subCoord.disconnect();
        await server.stop();
    });

    await test("mix of old JSON-in-nudge and new relay format in same session", async () => {
        const sock = tmpSocketPath();
        const server = new SwarmServer(new UnixTransportServer(sock));
        await server.start();

        const queen = new SwarmClient({ name: "queen", role: "queen" });
        const coord = new SwarmClient({ name: "coord-a", role: "coordinator", swarm: "s1" });
        await queen.connect(sock);
        await coord.connect(sock);

        const received: RelayedMessage[] = [];
        queen.on("message", (msg) => received.push(msg));

        // Send old format first
        const oldRelay = JSON.stringify({
            sub: true, type: "register", name: "old-agent",
            role: "agent", swarm: "s1", code: "0.1.1",
        });
        coord.nudge(oldRelay);

        // Then send new format
        coord.relay({
            event: "done",
            name: "new-agent",
            role: "agent",
            swarm: "s1",
            code: "0.1.2",
            summary: "using new format",
        });

        // And another old format
        coord.nudge(JSON.stringify({
            sub: true, type: "blocked", name: "old-agent-2",
            role: "agent", swarm: "s1", code: "0.1.3",
            description: "help needed",
        }));
        await delay(50);

        assertEqual(received.length, 3, "queen received all 3 messages");

        // First: old format arrives as nudge
        assertEqual(received[0].message.type, "nudge", "old format is nudge");
        const parsed = parseSubRelay((received[0].message as NudgeMessage).reason);
        assert(parsed !== null, "old format parseable");
        assertEqual(parsed!.name, "old-agent", "old agent name");

        // Second: new format arrives as relay
        assertEqual(received[1].message.type, "relay", "new format is relay");
        const relayMsg = received[1].message as RelayMessage;
        assertEqual(relayMsg.relay.name, "new-agent", "new agent name");
        assertEqual(relayMsg.relay.summary, "using new format", "summary");

        // Third: another old format arrives as nudge
        assertEqual(received[2].message.type, "nudge", "second old format is nudge");
        const parsed2 = parseSubRelay((received[2].message as NudgeMessage).reason);
        assert(parsed2 !== null, "second old format parseable");
        assertEqual(parsed2!.name, "old-agent-2", "second old agent name");

        queen.disconnect();
        coord.disconnect();
        await server.stop();
    });
}

main().then(() => summarize());
