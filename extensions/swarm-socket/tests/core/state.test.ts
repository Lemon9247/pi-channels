/**
 * State tests: generation counter, updateAgentStatus, graceful shutdown, parseSubRelay
 */

import { test, assert, assertEqual, tmpSocketPath, summarize } from "../helpers.js";
import {
    parseSubRelay,
    type AgentInfo,
    type SwarmState,
    setSwarmState,
    getSwarmState,
    getSwarmGeneration,
    updateAgentStatus,
    cleanupSwarm,
    gracefulShutdown,
} from "../../core/state.js";
import { SwarmServer } from "../../core/server.js";
import { UnixTransportServer } from "../../transport/unix-socket.js";

async function main() {
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

        updateAgentStatus("a1", "blocked");
        assert(getSwarmState() === null, "state still null after cleanup");
    });

    console.log("\nGraceful Shutdown:");

    await test("gracefulShutdown waits for agents to finish then cleans up", async () => {
        const sock = tmpSocketPath();
        const server = new SwarmServer(new UnixTransportServer(sock));
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

        setTimeout(() => {
            updateAgentStatus("a1", "done");
        }, 500);

        await gracefulShutdown(server, sendInstruct);

        assert(instructSent.includes("Wrap up"), "instruct was sent");
        assert(getSwarmState() === null, "state cleaned up");
    });

    // T2: gracefulShutdown timeout test — SKIPPED
    // The gracefulShutdown function has a hardcoded 30-second timeout with 2-second polling.
    // Testing the timeout path (agents never finish → cleanup after 30s) would require either:
    //   a) Waiting 30+ seconds in a test (unacceptable)
    //   b) A configurable timeout parameter (requires source change)
    // Recommendation: Add an optional `timeoutMs` parameter to gracefulShutdown() so tests
    // can use a short timeout (e.g., 100ms). Then add a test that verifies:
    //   - Set up state with running agent that never calls done
    //   - Call gracefulShutdown with timeoutMs=100
    //   - Verify state is cleaned up after ~100ms
    // For now, the happy path (agents finish before timeout) is covered above.

    await test("gracefulShutdown aborts if swarm replaced during wait", async () => {
        const sock1 = tmpSocketPath();
        const server1 = new SwarmServer(new UnixTransportServer(sock1));
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

        setTimeout(async () => {
            await cleanupSwarm();
            const sock2 = tmpSocketPath();
            const server2 = new SwarmServer(new UnixTransportServer(sock2));
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

        const current = getSwarmState();
        assert(current !== null, "new swarm still alive");
        assert(current!.agents.has("b1"), "new swarm has b1");

        await cleanupSwarm();
    });
}

main().then(() => summarize());
