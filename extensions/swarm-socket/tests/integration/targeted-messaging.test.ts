/**
 * Targeted messaging integration tests:
 * - Targeted nudges delivered only to named recipient
 * - Targeted blockers/done messages
 * - Nudge with payload serializes through the wire
 * - First-class relay messages route correctly
 * - Progress messages delivered to coordinators/queen
 */

import { test, assert, assertEqual, tmpSocketPath, delay, summarize } from "../helpers.js";
import { SwarmServer } from "../../core/server.js";
import { SwarmClient } from "../../core/client.js";
import type { RelayedMessage, NudgeMessage, RelayMessage, ProgressMessage } from "../../transport/protocol.js";

async function main() {
    console.log("\nTargeted Messaging:");

    // === Targeted nudges ===

    await test("targeted nudge delivered only to named recipient", async () => {
        const sock = tmpSocketPath();
        const server = new SwarmServer(sock);
        await server.start();

        const a1 = new SwarmClient({ name: "a1", role: "agent", swarm: "s1" });
        const a2 = new SwarmClient({ name: "a2", role: "agent", swarm: "s1" });
        const a3 = new SwarmClient({ name: "a3", role: "agent", swarm: "s1" });
        await a1.connect(sock);
        await a2.connect(sock);
        await a3.connect(sock);

        const a2Received: RelayedMessage[] = [];
        const a3Received: RelayedMessage[] = [];
        a2.on("message", (msg) => a2Received.push(msg));
        a3.on("message", (msg) => a3Received.push(msg));

        // a1 sends targeted nudge to a2 only
        a1.nudge("found auth bug", { to: "a2" });
        await delay(50);

        assertEqual(a2Received.length, 1, "a2 received targeted nudge");
        assertEqual(a3Received.length, 0, "a3 did NOT receive targeted nudge");
        assertEqual((a2Received[0].message as NudgeMessage).reason, "found auth bug", "reason correct");

        a1.disconnect();
        a2.disconnect();
        a3.disconnect();
        await server.stop();
    });

    await test("targeted nudge with swarm field targets swarm members", async () => {
        const sock = tmpSocketPath();
        const server = new SwarmServer(sock);
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

        // Queen nudges swarm s1 only
        queen.nudge("new plan", { swarm: "s1" });
        await delay(50);

        assertEqual(a1Received.length, 1, "a1 received swarm nudge");
        assertEqual(a2Received.length, 1, "a2 received swarm nudge");
        assertEqual(b1Received.length, 0, "b1 did NOT receive swarm nudge");

        queen.disconnect();
        a1.disconnect();
        a2.disconnect();
        b1.disconnect();
        await server.stop();
    });

    await test("targeted blocker goes only to named recipient", async () => {
        const sock = tmpSocketPath();
        const server = new SwarmServer(sock);
        await server.start();

        const a1 = new SwarmClient({ name: "a1", role: "agent", swarm: "s1" });
        const coord = new SwarmClient({ name: "coord", role: "coordinator", swarm: "s1" });
        const a2 = new SwarmClient({ name: "a2", role: "agent", swarm: "s1" });
        await a1.connect(sock);
        await coord.connect(sock);
        await a2.connect(sock);

        const coordReceived: RelayedMessage[] = [];
        const a2Received: RelayedMessage[] = [];
        coord.on("message", (msg) => coordReceived.push(msg));
        a2.on("message", (msg) => a2Received.push(msg));

        // a1 targets blocker to coordinator only
        a1.blocker("stuck on X", { to: "coord" });
        await delay(50);

        assertEqual(coordReceived.length, 1, "coord received targeted blocker");
        assertEqual(a2Received.length, 0, "a2 did NOT receive targeted blocker");
        assertEqual(coordReceived[0].message.type, "blocker", "message type");

        a1.disconnect();
        coord.disconnect();
        a2.disconnect();
        await server.stop();
    });

    // === Nudge with payload ===

    await test("nudge with payload serializes through the wire correctly", async () => {
        const sock = tmpSocketPath();
        const server = new SwarmServer(sock);
        await server.start();

        const a1 = new SwarmClient({ name: "a1", role: "agent", swarm: "s1" });
        const a2 = new SwarmClient({ name: "a2", role: "agent", swarm: "s1" });
        await a1.connect(sock);
        await a2.connect(sock);

        const received: RelayedMessage[] = [];
        a2.on("message", (msg) => received.push(msg));

        a1.nudge("updated protocol types", {
            payload: {
                file: "transport/protocol.ts",
                snippet: "added BaseMessage interface",
                section: "Findings",
                tags: ["protocol", "types"],
            },
        });
        await delay(50);

        assertEqual(received.length, 1, "received nudge with payload");
        const nudge = received[0].message as NudgeMessage;
        assertEqual(nudge.reason, "updated protocol types", "reason");
        assert(nudge.payload !== undefined, "payload present");
        assertEqual(nudge.payload!.file, "transport/protocol.ts", "file");
        assertEqual(nudge.payload!.snippet, "added BaseMessage interface", "snippet");
        assertEqual(nudge.payload!.section, "Findings", "section");
        assertEqual(nudge.payload!.tags!.length, 2, "tags count");
        assertEqual(nudge.payload!.tags![0], "protocol", "first tag");

        a1.disconnect();
        a2.disconnect();
        await server.stop();
    });

    // === First-class relay messages ===

    await test("first-class relay message routes to queen", async () => {
        const sock = tmpSocketPath();
        const server = new SwarmServer(sock);
        await server.start();

        const queen = new SwarmClient({ name: "queen", role: "queen" });
        const coord = new SwarmClient({ name: "coord-a", role: "coordinator", swarm: "s1" });
        await queen.connect(sock);
        await coord.connect(sock);

        const received: RelayedMessage[] = [];
        queen.on("message", (msg) => received.push(msg));

        coord.relay({
            event: "register",
            name: "sub-agent-1",
            role: "agent",
            swarm: "s1",
            code: "0.1.1",
        });
        await delay(50);

        assertEqual(received.length, 1, "queen received relay message");
        const relayMsg = received[0].message as RelayMessage;
        assertEqual(relayMsg.type, "relay", "type is relay");
        assertEqual(relayMsg.relay.event, "register", "event is register");
        assertEqual(relayMsg.relay.name, "sub-agent-1", "agent name");
        assertEqual(relayMsg.relay.code, "0.1.1", "code");

        queen.disconnect();
        coord.disconnect();
        await server.stop();
    });

    await test("first-class relay with done event carries summary", async () => {
        const sock = tmpSocketPath();
        const server = new SwarmServer(sock);
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
            summary: "completed protocol enrichment",
        });
        await delay(50);

        assertEqual(received.length, 1, "queen received relay");
        const relayMsg = received[0].message as RelayMessage;
        assertEqual(relayMsg.relay.event, "done", "event is done");
        assertEqual(relayMsg.relay.summary, "completed protocol enrichment", "summary");

        queen.disconnect();
        coord.disconnect();
        await server.stop();
    });

    // === Progress messages ===

    await test("progress message delivered to coordinator", async () => {
        const sock = tmpSocketPath();
        const server = new SwarmServer(sock);
        await server.start();

        const coord = new SwarmClient({ name: "coord", role: "coordinator", swarm: "s1" });
        const a1 = new SwarmClient({ name: "a1", role: "agent", swarm: "s1" });
        await coord.connect(sock);
        await a1.connect(sock);

        const received: RelayedMessage[] = [];
        coord.on("message", (msg) => received.push(msg));

        a1.progress({ phase: "reading files", percent: 25, detail: "5/20 files read" });
        await delay(50);

        assertEqual(received.length, 1, "coord received progress");
        const progress = received[0].message as ProgressMessage;
        assertEqual(progress.type, "progress", "type is progress");
        assertEqual(progress.phase, "reading files", "phase");
        assertEqual(progress.percent, 25, "percent");
        assertEqual(progress.detail, "5/20 files read", "detail");

        coord.disconnect();
        a1.disconnect();
        await server.stop();
    });

    await test("progress message with only phase works", async () => {
        const sock = tmpSocketPath();
        const server = new SwarmServer(sock);
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

        coord.disconnect();
        a1.disconnect();
        await server.stop();
    });

    // === Error handling for targeted messages ===

    await test("targeted nudge to nonexistent agent returns error", async () => {
        const sock = tmpSocketPath();
        const server = new SwarmServer(sock);
        await server.start();

        const queen = new SwarmClient({ name: "queen", role: "queen" });
        await queen.connect(sock);

        const errors: string[] = [];
        queen.on("error", (msg) => errors.push(msg));

        queen.nudge("test", { to: "nonexistent" });
        await delay(50);

        assertEqual(errors.length, 1, "got error for no recipient");
        assert(errors[0].includes("nonexistent"), "error mentions target");

        queen.disconnect();
        await server.stop();
    });

    // === Backward compat: old-format relay nudges still work ===

    await test("old-format JSON-in-nudge relay still parseable on wire", async () => {
        const sock = tmpSocketPath();
        const server = new SwarmServer(sock);
        await server.start();

        const queen = new SwarmClient({ name: "queen", role: "queen" });
        const coord = new SwarmClient({ name: "coord", role: "coordinator", swarm: "s1" });
        await queen.connect(sock);
        await coord.connect(sock);

        const received: RelayedMessage[] = [];
        queen.on("message", (msg) => received.push(msg));

        // Send old format
        const oldRelay = JSON.stringify({
            sub: true,
            type: "register",
            name: "legacy-agent",
            role: "agent",
            swarm: "s1",
            code: "0.1.1",
        });
        coord.nudge(oldRelay);
        await delay(50);

        assertEqual(received.length, 1, "queen received old-format relay");
        // It arrives as a nudge with the JSON string as reason
        assertEqual(received[0].message.type, "nudge", "still a nudge type on wire");
        const nudge = received[0].message as NudgeMessage;
        // The JSON should be parseable
        const parsed = JSON.parse(nudge.reason);
        assertEqual(parsed.sub, true, "sub flag");
        assertEqual(parsed.name, "legacy-agent", "agent name");

        queen.disconnect();
        coord.disconnect();
        await server.stop();
    });
}

main().then(() => summarize());
