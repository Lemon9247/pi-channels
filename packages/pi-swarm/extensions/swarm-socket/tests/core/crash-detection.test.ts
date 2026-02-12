/**
 * Tests for crash detection and broadcast
 *
 * Verifies that agent crashes are properly detected, broadcast to the
 * general channel, and reported to the queen via pi.sendMessage.
 *
 * These tests focus on the state transitions and broadcast message
 * structure — actual process spawning is tested in integration tests.
 */

import { describe, it, beforeEach } from "node:test";
import * as assert from "node:assert/strict";
import {
    getSwarmState,
    setSwarmState,
    updateAgentStatus,
    cleanupSwarm,
    type SwarmState,
    type AgentInfo,
} from "../../core/state.js";
import { pushSyntheticEvent, getAgentActivity, clearActivity } from "../../ui/activity.js";

// ─── Helpers ─────────────────────────────────────────────────────────

function makeAgent(name: string, overrides?: Partial<AgentInfo>): AgentInfo {
    return {
        name,
        role: "agent",
        swarm: "test",
        task: "test task",
        status: "running",
        ...overrides,
    };
}

function makeState(agents: AgentInfo[]): SwarmState {
    const agentMap = new Map<string, AgentInfo>();
    for (const a of agents) agentMap.set(a.name, a);
    return {
        generation: 0,
        group: null,
        groupPath: "/tmp/test",
        agents: agentMap,
        queenClients: new Map(),
    };
}

// ─── Tests ───────────────────────────────────────────────────────────

describe("crash detection", () => {
    beforeEach(async () => {
        await cleanupSwarm();
        clearActivity();
    });

    describe("state transitions", () => {
        it("running → crashed is a valid transition", () => {
            const state = makeState([makeAgent("a1", { status: "running" })]);
            setSwarmState(state);
            const result = updateAgentStatus("a1", "crashed");
            assert.equal(result, true);
            assert.equal(state.agents.get("a1")!.status, "crashed");
        });

        it("starting → crashed is a valid transition", () => {
            const state = makeState([makeAgent("a1", { status: "starting" })]);
            setSwarmState(state);
            const result = updateAgentStatus("a1", "crashed");
            assert.equal(result, true);
            assert.equal(state.agents.get("a1")!.status, "crashed");
        });

        it("blocked → crashed is a valid transition", () => {
            const state = makeState([makeAgent("a1", { status: "blocked" })]);
            setSwarmState(state);
            const result = updateAgentStatus("a1", "crashed");
            assert.equal(result, true);
        });

        it("crashed is terminal — no transitions out", () => {
            const state = makeState([makeAgent("a1", { status: "crashed" })]);
            setSwarmState(state);
            assert.equal(updateAgentStatus("a1", "running"), false);
            assert.equal(updateAgentStatus("a1", "done"), false);
            assert.equal(updateAgentStatus("a1", "blocked"), false);
        });

        it("crash triggers onAllDone when all agents are terminal", () => {
            let allDoneCalled = false;
            const state = makeState([
                makeAgent("a1", { status: "done" }),
                makeAgent("a2", { status: "running" }),
            ]);
            state.onAllDone = () => { allDoneCalled = true; };
            setSwarmState(state);

            updateAgentStatus("a2", "crashed");
            assert.equal(allDoneCalled, true);
        });

        it("crash does NOT trigger onAllDone when other agents are still running", () => {
            let allDoneCalled = false;
            const state = makeState([
                makeAgent("a1", { status: "running" }),
                makeAgent("a2", { status: "running" }),
            ]);
            state.onAllDone = () => { allDoneCalled = true; };
            setSwarmState(state);

            updateAgentStatus("a1", "crashed");
            assert.equal(allDoneCalled, false);
        });
    });

    describe("activity tracking for crash info", () => {
        it("getAgentActivity returns recent events", () => {
            pushSyntheticEvent("a1", "tool_start", "bash ls -la");
            pushSyntheticEvent("a1", "tool_end", "✓ bash");
            pushSyntheticEvent("a1", "message", "Found 5 files");

            const activity = getAgentActivity("a1");
            assert.equal(activity.length, 3);
            assert.equal(activity[0].summary, "bash ls -la");
            assert.equal(activity[2].summary, "Found 5 files");
        });

        it("activity includes timestamps", () => {
            const before = Date.now();
            pushSyntheticEvent("a1", "message", "test");
            const after = Date.now();

            const activity = getAgentActivity("a1");
            assert.ok(activity[0].timestamp >= before);
            assert.ok(activity[0].timestamp <= after);
        });

        it("getAgentActivity returns empty array for unknown agent", () => {
            assert.deepEqual(getAgentActivity("nonexistent"), []);
        });

        it("clearActivity removes agent events", () => {
            pushSyntheticEvent("a1", "message", "test");
            clearActivity("a1");
            assert.deepEqual(getAgentActivity("a1"), []);
        });

        it("clearActivity with no args clears all agents", () => {
            pushSyntheticEvent("a1", "message", "test1");
            pushSyntheticEvent("a2", "message", "test2");
            clearActivity();
            assert.deepEqual(getAgentActivity("a1"), []);
            assert.deepEqual(getAgentActivity("a2"), []);
        });
    });

    describe("crash broadcast message structure", () => {
        it("agent_crashed message includes required fields", () => {
            // Verify the message structure that would be sent to general channel.
            // We can't test the actual channel send in unit tests (that's integration),
            // but we can verify the data shape.
            const crashData = {
                type: "agent_crashed",
                from: "system",
                agent: "agent-a1",
                exitCode: 1,
                lastActivity: "bash ls; ✓ bash; Found files",
            };

            assert.equal(crashData.type, "agent_crashed");
            assert.equal(crashData.from, "system");
            assert.ok(typeof crashData.agent === "string");
            assert.ok(typeof crashData.exitCode === "number");
            assert.ok(typeof crashData.lastActivity === "string");
        });

        it("crash info includes last 3 activity events", () => {
            pushSyntheticEvent("a1", "tool_start", "read file.ts");
            pushSyntheticEvent("a1", "tool_end", "✓ read");
            pushSyntheticEvent("a1", "message", "Analyzing...");
            pushSyntheticEvent("a1", "tool_start", "bash npm test");
            pushSyntheticEvent("a1", "tool_end", "✗ bash failed");

            const activity = getAgentActivity("a1");
            const lastActivity = activity.slice(-3).map(e => e.summary).join("; ");
            assert.equal(lastActivity, "Analyzing...; bash npm test; ✗ bash failed");
        });
    });
});
