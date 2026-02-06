/**
 * Tests for swarm socket protocol, server, and client.
 *
 * Run with: npx tsx test.ts
 */

import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { SwarmServer } from "./server.js";
import { SwarmClient } from "./client.js";
import { parseLines, serialize, validateRegister, validateClientMessage } from "./protocol.js";
import { parseSubRelay, buildChildrenMap, codeLevel, parentCode, isDescendantOf, type AgentInfo, type SwarmState, setSwarmState, getSwarmState, getSwarmGeneration, updateAgentStatus, cleanupSwarm, gracefulShutdown } from "./state.js";
import { pushSyntheticEvent, getAgentActivity, clearActivity } from "./activity.js";

// === Test infrastructure ===

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, message: string): void {
    if (!condition) {
        throw new Error(`Assertion failed: ${message}`);
    }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
    if (actual !== expected) {
        throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        failed++;
        const msg = err instanceof Error ? err.message : String(err);
        failures.push(`${name}: ${msg}`);
        console.log(`  ✗ ${name}: ${msg}`);
    }
}

function tmpSocketPath(): string {
    return path.join(os.tmpdir(), `pi-swarm-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
}

// Small delay helper
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// === Protocol tests ===

async function protocolTests() {
    console.log("\nProtocol:");

    await test("serialize produces JSON line", async () => {
        const result = serialize({ type: "nudge", reason: "test" });
        assert(result.endsWith("\n"), "should end with newline");
        const parsed = JSON.parse(result.trim());
        assertEqual(parsed.type, "nudge", "type");
        assertEqual(parsed.reason, "test", "reason");
    });

    await test("parseLines handles complete lines", async () => {
        const input = '{"type":"nudge","reason":"a"}\n{"type":"done","summary":"b"}\n';
        const { messages, remainder } = parseLines(input);
        assertEqual(messages.length, 2, "should parse 2 messages");
        assertEqual(remainder, "", "no remainder");
    });

    await test("parseLines handles partial line", async () => {
        const input = '{"type":"nudge","reason":"a"}\n{"type":"do';
        const { messages, remainder } = parseLines(input);
        assertEqual(messages.length, 1, "should parse 1 message");
        assertEqual(remainder, '{"type":"do', "partial remainder");
    });

    await test("parseLines handles empty input", async () => {
        const { messages, remainder } = parseLines("");
        assertEqual(messages.length, 0, "no messages");
        assertEqual(remainder, "", "no remainder");
    });

    await test("parseLines skips malformed lines", async () => {
        const input = 'not json\n{"type":"nudge","reason":"ok"}\n';
        const { messages, remainder } = parseLines(input);
        assertEqual(messages.length, 1, "should parse 1 valid message");
    });

    await test("parseLines reassembles across chunks", async () => {
        // Simulate two data chunks splitting a message
        const chunk1 = '{"type":"nud';
        const chunk2 = 'ge","reason":"split"}\n';

        const r1 = parseLines(chunk1);
        assertEqual(r1.messages.length, 0, "no complete messages in chunk1");

        const r2 = parseLines(r1.remainder + chunk2);
        assertEqual(r2.messages.length, 1, "reassembled message from chunks");
        assertEqual((r2.messages[0] as any).reason, "split", "correct content");
    });

    await test("validateRegister accepts valid queen", async () => {
        assert(validateRegister({ type: "register", name: "queen", role: "queen" }), "queen valid");
    });

    await test("validateRegister accepts valid agent with swarm", async () => {
        assert(
            validateRegister({ type: "register", name: "a1", role: "agent", swarm: "analysis" }),
            "agent with swarm valid",
        );
    });

    await test("validateRegister rejects agent without swarm", async () => {
        assert(!validateRegister({ type: "register", name: "a1", role: "agent" }), "agent without swarm invalid");
    });

    await test("validateRegister rejects empty name", async () => {
        assert(!validateRegister({ type: "register", name: "", role: "queen" }), "empty name invalid");
    });

    await test("validateClientMessage validates all types", async () => {
        assert(validateClientMessage({ type: "nudge", reason: "test" }), "nudge valid");
        assert(validateClientMessage({ type: "blocker", description: "stuck" }), "blocker valid");
        assert(validateClientMessage({ type: "done", summary: "finished" }), "done valid");
        assert(validateClientMessage({ type: "instruct", instruction: "do this" }), "instruct valid");
        assert(!validateClientMessage({ type: "unknown" }), "unknown type invalid");
        assert(!validateClientMessage(null), "null invalid");
    });
}

// === Server + Client integration tests ===

async function integrationTests() {
    console.log("\nServer + Client Integration:");

    await test("server starts and stops cleanly", async () => {
        const sock = tmpSocketPath();
        const server = new SwarmServer(sock);
        await server.start();
        assert(fs.existsSync(sock), "socket file exists");
        await server.stop();
        assert(!fs.existsSync(sock), "socket file cleaned up");
    });

    await test("client connects and registers", async () => {
        const sock = tmpSocketPath();
        const server = new SwarmServer(sock);
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
        const server = new SwarmServer(sock);
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
        const server = new SwarmServer(sock);
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
        const server = new SwarmServer(sock);
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
        const server = new SwarmServer(sock);
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
        const server = new SwarmServer(sock);
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
        const server = new SwarmServer(sock);
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
        const server = new SwarmServer(sock);
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
        const server = new SwarmServer(sock);
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
        const server = new SwarmServer(sock);
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
        const server = new SwarmServer(sock);
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
        const server = new SwarmServer(sock, {
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
        const server = new SwarmServer(sock);
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
        const server = new SwarmServer(sock);
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

        // Test 1: a1 nudge reaches a2 and coord-a, but NOT b1, b2, coord-b, queen
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

        // Clear
        for (const k of Object.keys(msgs)) msgs[k] = [];

        // Test 2: coord-a nudge reaches coord-b and queen, plus own agents, but NOT swarm B agents
        coordA.nudge("coordinator nudge");
        await delay(50);

        assertEqual(msgs.queen.length, 1, "queen got coord nudge");
        assertEqual(msgs["coord-b"].length, 1, "coord-b got coord nudge");
        assertEqual(msgs.a1.length, 1, "a1 got own coordinator's nudge");
        assertEqual(msgs.a2.length, 1, "a2 got own coordinator's nudge");
        assertEqual(msgs.b1.length, 0, "b1 did NOT get coord-a's nudge");
        assertEqual(msgs.b2.length, 0, "b2 did NOT get coord-a's nudge");

        // Clean up
        for (const c of [queen, coordA, coordB, a1, a2, b1, b2]) c.disconnect();
        await server.stop();
    });
}

// === Hierarchy & Relay tests ===

async function hierarchyTests() {
    console.log("\nHierarchy Helpers:");

    await test("codeLevel — root is 0, children are 1, grandchildren are 2", async () => {
        assertEqual(codeLevel("0"), 0, "root");
        assertEqual(codeLevel("0.1"), 1, "child");
        assertEqual(codeLevel("0.1.2"), 2, "grandchild");
        assertEqual(codeLevel("0.1.2.3"), 3, "great-grandchild");
    });

    await test("parentCode — strips last segment", async () => {
        assertEqual(parentCode("0"), "", "root→empty");
        assertEqual(parentCode("0.1"), "0", "child→root");
        assertEqual(parentCode("0.1.2"), "0.1", "grandchild→child");
        assertEqual(parentCode("0.1.2.3"), "0.1.2", "great-grandchild→grandchild");
    });

    await test("isDescendantOf — prefix matching", async () => {
        assert(isDescendantOf("0.1", "0"), "0.1 under 0");
        assert(isDescendantOf("0.1.2", "0"), "0.1.2 under 0");
        assert(isDescendantOf("0.1.2", "0.1"), "0.1.2 under 0.1");
        assert(!isDescendantOf("0.1", "0.1"), "not descendant of self");
        assert(!isDescendantOf("0.2", "0.1"), "0.2 not under 0.1");
        assert(!isDescendantOf("0.10", "0.1"), "0.10 not under 0.1 (prefix trap)");
    });

    await test("buildChildrenMap — flat list", async () => {
        const agents: AgentInfo[] = [
            { name: "a1", role: "agent", swarm: "s1", task: "t", status: "running", code: "0.1" },
            { name: "a2", role: "agent", swarm: "s1", task: "t", status: "running", code: "0.2" },
        ];
        const { children } = buildChildrenMap(agents);
        assertEqual(children.get("0")?.length, 2, "root has 2 children");
        assertEqual(children.get("0")![0].name, "a1", "sorted by code");
    });

    await test("buildChildrenMap — nested tree", async () => {
        const agents: AgentInfo[] = [
            { name: "coord", role: "coordinator", swarm: "s1", task: "t", status: "running", code: "0.1" },
            { name: "a2", role: "agent", swarm: "s1", task: "t", status: "running", code: "0.1.2" },
            { name: "a1", role: "agent", swarm: "s1", task: "t", status: "running", code: "0.1.1" },
            { name: "b1", role: "agent", swarm: "s2", task: "t", status: "running", code: "0.2" },
        ];
        const { children, sorted } = buildChildrenMap(agents);
        assertEqual(sorted[0].name, "coord", "coord first in sorted");
        assertEqual(children.get("0")?.length, 2, "root has 2 children (coord + b1)");
        assertEqual(children.get("0.1")?.length, 2, "coord has 2 children");
        assertEqual(children.get("0.1")![0].name, "a1", "a1 before a2 under coord");
    });

    await test("buildChildrenMap — empty list", async () => {
        const { children, sorted } = buildChildrenMap([]);
        assertEqual(sorted.length, 0, "no agents");
        assertEqual(children.size, 0, "no children");
    });
}

async function relayTests() {
    console.log("\nRelay Protocol:");

    await test("parseSubRelay — valid relay", async () => {
        const relay = parseSubRelay(JSON.stringify({
            sub: true, type: "register", name: "a1", role: "agent", swarm: "s1", code: "0.1.1",
        }));
        assert(relay !== null, "should parse");
        assertEqual(relay!.type, "register", "type");
        assertEqual(relay!.name, "a1", "name");
        assertEqual(relay!.code, "0.1.1", "code");
    });

    await test("parseSubRelay — not JSON returns null", async () => {
        const relay = parseSubRelay("just a string");
        assert(relay === null, "should be null");
    });

    await test("parseSubRelay — JSON without sub flag returns null", async () => {
        const relay = parseSubRelay(JSON.stringify({ type: "nudge", reason: "hi" }));
        assert(relay === null, "should be null (no sub: true)");
    });

    await test("parseSubRelay — sub: false returns null", async () => {
        const relay = parseSubRelay(JSON.stringify({ sub: false, type: "done", name: "a1" }));
        assert(relay === null, "should be null (sub is false)");
    });

    await test("parseSubRelay — empty object returns null", async () => {
        const relay = parseSubRelay("{}");
        assert(relay === null, "should be null");
    });
}

async function syntheticActivityTests() {
    console.log("\nSynthetic Activity:");

    await test("pushSyntheticEvent stores events retrievable via getAgentActivity", async () => {
        clearActivity();
        pushSyntheticEvent("test-agent", "message", "registered (agent, s1)");
        pushSyntheticEvent("test-agent", "tool_end", "✓ done: completed");

        const events = getAgentActivity("test-agent");
        assertEqual(events.length, 2, "2 events");
        assertEqual(events[0].summary, "registered (agent, s1)", "first event");
        assertEqual(events[1].summary, "✓ done: completed", "second event");
        clearActivity();
    });

    await test("pushSyntheticEvent — different agents have separate feeds", async () => {
        clearActivity();
        pushSyntheticEvent("alpha", "message", "event-a");
        pushSyntheticEvent("beta", "message", "event-b");

        assertEqual(getAgentActivity("alpha").length, 1, "alpha has 1");
        assertEqual(getAgentActivity("beta").length, 1, "beta has 1");
        assertEqual(getAgentActivity("alpha")[0].summary, "event-a", "alpha event");
        assertEqual(getAgentActivity("beta")[0].summary, "event-b", "beta event");
        clearActivity();
    });
}

async function relayIntegrationTests() {
    console.log("\nRelay Integration:");

    await test("coordinator relays sub-agent registration to queen via JSON nudge", async () => {
        const sock = tmpSocketPath();
        const server = new SwarmServer(sock);
        await server.start();

        const queen = new SwarmClient({ name: "queen", role: "queen" });
        const coord = new SwarmClient({ name: "coord-a", role: "coordinator", swarm: "s1" });
        await queen.connect(sock);
        await coord.connect(sock);

        const received: any[] = [];
        queen.on("message", (msg) => received.push(msg));

        // Coordinator sends a relay nudge (simulating what swarm-tool does when a sub-agent registers)
        const relay = { sub: true, type: "register", name: "a1", role: "agent", swarm: "s1", code: "0.1.1" };
        coord.nudge(JSON.stringify(relay));
        await delay(50);

        assertEqual(received.length, 1, "queen received relay nudge");
        // Queen can parse this as a sub-agent relay
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
        const server = new SwarmServer(sock);
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
        const server = new SwarmServer(sock);
        await server.start();

        const queen = new SwarmClient({ name: "queen", role: "queen" });
        const coord = new SwarmClient({ name: "coord-a", role: "coordinator", swarm: "s1" });
        // In reality sub-coord would be on its own socket, but for relay testing
        // we can simulate it on the same socket as a coordinator in s1
        const subCoord = new SwarmClient({ name: "sub-coord", role: "coordinator", swarm: "s1" });
        await queen.connect(sock);
        await coord.connect(sock);
        await subCoord.connect(sock);

        const queenReceived: any[] = [];
        const coordReceived: any[] = [];
        queen.on("message", (msg) => queenReceived.push(msg));
        coord.on("message", (msg) => coordReceived.push(msg));

        // Sub-coord sends relay about a deep agent
        const relay = { sub: true, type: "register", name: "deep-agent", role: "agent", swarm: "s1", code: "0.1.1.1" };
        subCoord.nudge(JSON.stringify(relay));
        await delay(50);

        // Both queen and coord should receive it (coordinators + queen see coordinator nudges)
        assert(queenReceived.length >= 1, "queen received relay");
        assert(coordReceived.length >= 1, "coord received relay");

        // Both can parse the relay
        const queenRelay = parseSubRelay(queenReceived[0].message.reason)!;
        assertEqual(queenRelay.name, "deep-agent", "queen sees deep agent");
        assertEqual(queenRelay.code, "0.1.1.1", "queen sees deep code");

        queen.disconnect();
        coord.disconnect();
        subCoord.disconnect();
        await server.stop();
    });
}

async function generationTests() {
    console.log("\nGeneration Counter:");

    await test("setSwarmState increments generation", async () => {
        const gen1 = getSwarmGeneration();
        const state1: SwarmState = {
            generation: 0,
            server: null,
            socketPath: "/tmp/test1.sock",
            agents: new Map(),
        };
        setSwarmState(state1);
        const gen2 = getSwarmGeneration();
        assert(gen2 > gen1, "generation increased");
        assertEqual(state1.generation, gen2, "state.generation matches");

        const state2: SwarmState = {
            generation: 0,
            server: null,
            socketPath: "/tmp/test2.sock",
            agents: new Map(),
        };
        setSwarmState(state2);
        const gen3 = getSwarmGeneration();
        assert(gen3 > gen2, "generation increased again");
        assertEqual(state2.generation, gen3, "state2.generation matches");

        // Clean up
        await cleanupSwarm();
    });

    await test("stale generation is detectable", async () => {
        const state: SwarmState = {
            generation: 0,
            server: null,
            socketPath: "/tmp/test-stale.sock",
            agents: new Map(),
        };
        setSwarmState(state);
        const capturedGen = getSwarmGeneration();

        // Simulate new swarm replacing old one
        const state2: SwarmState = {
            generation: 0,
            server: null,
            socketPath: "/tmp/test-stale2.sock",
            agents: new Map(),
        };
        setSwarmState(state2);

        assert(getSwarmGeneration() !== capturedGen, "captured gen is now stale");

        await cleanupSwarm();
    });

    await test("updateAgentStatus only works on active swarm", async () => {
        const agents = new Map<string, AgentInfo>();
        agents.set("a1", {
            name: "a1", role: "agent", swarm: "s1", task: "t",
            status: "running", code: "0.1",
        });
        const state: SwarmState = {
            generation: 0,
            server: null,
            socketPath: "/tmp/test-update.sock",
            agents,
        };
        setSwarmState(state);
        updateAgentStatus("a1", "done");
        assertEqual(getSwarmState()!.agents.get("a1")!.status, "done", "updated");

        await cleanupSwarm();

        // After cleanup, state is null — updateAgentStatus should be a no-op
        updateAgentStatus("a1", "blocked");
        assert(getSwarmState() === null, "state still null after cleanup");
    });
}

async function gracefulShutdownTests() {
    console.log("\nGraceful Shutdown:");

    await test("gracefulShutdown waits for agents to finish then cleans up", async () => {
        const sock = tmpSocketPath();
        const server = new SwarmServer(sock);
        await server.start();

        const agents = new Map<string, AgentInfo>();
        agents.set("a1", {
            name: "a1", role: "agent", swarm: "s1", task: "t",
            status: "running", code: "0.1",
        });
        const state: SwarmState = {
            generation: 0,
            server,
            socketPath: sock,
            agents,
        };
        setSwarmState(state);

        let instructSent = "";
        const sendInstruct = (msg: string) => { instructSent = msg; };

        // Simulate agent finishing shortly after shutdown starts
        setTimeout(() => {
            updateAgentStatus("a1", "done");
        }, 500);

        await gracefulShutdown(server, sendInstruct);

        assert(instructSent.includes("Wrap up"), "instruct was sent");
        assert(getSwarmState() === null, "state cleaned up");
    });

    await test("gracefulShutdown aborts if swarm replaced during wait", async () => {
        const sock1 = tmpSocketPath();
        const server1 = new SwarmServer(sock1);
        await server1.start();

        const agents = new Map<string, AgentInfo>();
        agents.set("a1", {
            name: "a1", role: "agent", swarm: "s1", task: "t",
            status: "running", code: "0.1",
        });
        const state1: SwarmState = {
            generation: 0,
            server: server1,
            socketPath: sock1,
            agents,
        };
        setSwarmState(state1);

        // Replace swarm during gracefulShutdown's wait
        setTimeout(async () => {
            await cleanupSwarm(); // kills state1
            const sock2 = tmpSocketPath();
            const server2 = new SwarmServer(sock2);
            await server2.start();
            const state2: SwarmState = {
                generation: 0,
                server: server2,
                socketPath: sock2,
                agents: new Map([["b1", {
                    name: "b1", role: "agent", swarm: "s2", task: "t",
                    status: "running", code: "0.1",
                }]]),
            };
            setSwarmState(state2);
        }, 500);

        await gracefulShutdown(server1, () => {});

        // State2 should still be alive — gracefulShutdown should NOT have killed it
        const current = getSwarmState();
        assert(current !== null, "new swarm still alive");
        assert(current!.agents.has("b1"), "new swarm has b1");

        await cleanupSwarm();
    });
}

// === Run ===

async function main() {
    console.log("Swarm Socket Tests");
    await protocolTests();
    await integrationTests();
    await hierarchyTests();
    await relayTests();
    await relayIntegrationTests();
    await syntheticActivityTests();
    await generationTests();
    await gracefulShutdownTests();

    console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
    if (failures.length > 0) {
        console.log("\nFailures:");
        for (const f of failures) console.log(`  - ${f}`);
    }
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
    console.error("Test runner error:", err);
    process.exit(1);
});
