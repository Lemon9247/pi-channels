/**
 * Tests for core/state.ts
 *
 * Verifies swarm state management, agent status updates,
 * state machine transitions, and cleanup.
 */

import { describe, it, beforeEach } from "node:test";
import * as assert from "node:assert/strict";
import {
    getSwarmState,
    setSwarmState,
    getSwarmGeneration,
    updateAgentStatus,
    getParentClients,
    setParentClients,
    cleanupSwarm,
    isValidTransition,
    VALID_TRANSITIONS,
    type SwarmState,
    type AgentInfo,
    type AgentStatus,
} from "../../core/state.js";

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

describe("state", () => {
    beforeEach(async () => {
        // Clean up any existing state
        await cleanupSwarm();
        setParentClients(null);
    });

    describe("swarm state", () => {
        it("starts with no active swarm", () => {
            assert.equal(getSwarmState(), null);
        });

        it("sets and gets swarm state", () => {
            const state: SwarmState = {
                generation: 0,
                group: null,
                groupPath: "/tmp/test",
                agents: new Map(),
                queenClients: new Map(),
            };
            setSwarmState(state);
            assert.equal(getSwarmState(), state);
        });

        it("increments generation on each setSwarmState", () => {
            const gen1 = getSwarmGeneration();

            setSwarmState({
                generation: 0,
                group: null,
                groupPath: "/tmp/test1",
                agents: new Map(),
                queenClients: new Map(),
            });
            const gen2 = getSwarmGeneration();
            assert.ok(gen2 > gen1);

            setSwarmState({
                generation: 0,
                group: null,
                groupPath: "/tmp/test2",
                agents: new Map(),
                queenClients: new Map(),
            });
            const gen3 = getSwarmGeneration();
            assert.ok(gen3 > gen2);
        });

        it("sets generation on the state object", () => {
            const state: SwarmState = {
                generation: 0,
                group: null,
                groupPath: "/tmp/test",
                agents: new Map(),
                queenClients: new Map(),
            };
            setSwarmState(state);
            assert.ok(state.generation > 0);
            assert.equal(state.generation, getSwarmGeneration());
        });
    });

    describe("state machine", () => {
        it("terminal states have no valid transitions", () => {
            assert.equal(VALID_TRANSITIONS.done.size, 0);
            assert.equal(VALID_TRANSITIONS.crashed.size, 0);
            assert.equal(VALID_TRANSITIONS.disconnected.size, 0);
        });

        it("starting can transition to running, done, blocked, crashed, disconnected", () => {
            assert.ok(isValidTransition("starting", "running"));
            assert.ok(isValidTransition("starting", "done"));
            assert.ok(isValidTransition("starting", "blocked"));
            assert.ok(isValidTransition("starting", "crashed"));
            assert.ok(isValidTransition("starting", "disconnected"));
        });

        it("running can transition to done, blocked, crashed, disconnected", () => {
            assert.ok(isValidTransition("running", "done"));
            assert.ok(isValidTransition("running", "blocked"));
            assert.ok(isValidTransition("running", "crashed"));
            assert.ok(isValidTransition("running", "disconnected"));
            assert.ok(!isValidTransition("running", "starting"));
        });

        it("blocked can transition to running, done, crashed, disconnected", () => {
            assert.ok(isValidTransition("blocked", "running"));
            assert.ok(isValidTransition("blocked", "done"));
            assert.ok(isValidTransition("blocked", "crashed"));
            assert.ok(isValidTransition("blocked", "disconnected"));
            assert.ok(!isValidTransition("blocked", "starting"));
        });

        it("crashed→running is invalid (the ghost transition)", () => {
            assert.ok(!isValidTransition("crashed", "running"));
        });

        it("done→running is invalid", () => {
            assert.ok(!isValidTransition("done", "running"));
        });

        // ─── Idle state transitions ─────────────────────────────

        it("running → idle is valid (hive_done, agent stays alive)", () => {
            assert.ok(isValidTransition("running", "idle"));
        });

        it("idle → running is valid (re-tasked via swarm_instruct)", () => {
            assert.ok(isValidTransition("idle", "running"));
        });

        it("idle → done is valid (dismissed via hive_dismiss)", () => {
            assert.ok(isValidTransition("idle", "done"));
        });

        it("starting → idle is valid (fast agent race condition)", () => {
            assert.ok(isValidTransition("starting", "idle"));
        });

        it("blocked → idle is valid (unblocked but not resuming)", () => {
            assert.ok(isValidTransition("blocked", "idle"));
        });

        it("idle → blocked is invalid", () => {
            assert.ok(!isValidTransition("idle", "blocked"));
        });

        it("idle → crashed is valid (process crash while idle)", () => {
            assert.ok(isValidTransition("idle", "crashed"));
        });

        it("idle → disconnected is valid (process disconnect while idle)", () => {
            assert.ok(isValidTransition("idle", "disconnected"));
        });

        it("idle → starting is invalid", () => {
            assert.ok(!isValidTransition("idle", "starting"));
        });

        it("done → idle is invalid (done is terminal)", () => {
            assert.ok(!isValidTransition("done", "idle"));
        });

        it("crashed → idle is invalid (crashed is terminal)", () => {
            assert.ok(!isValidTransition("crashed", "idle"));
        });

        it("starting includes idle in valid transitions", () => {
            const startingTransitions = VALID_TRANSITIONS.starting;
            assert.ok(startingTransitions.has("idle"));
            assert.ok(startingTransitions.has("running"));
            assert.ok(startingTransitions.has("done"));
            assert.ok(startingTransitions.has("blocked"));
            assert.ok(startingTransitions.has("crashed"));
            assert.ok(startingTransitions.has("disconnected"));
        });
    });

    describe("updateAgentStatus", () => {
        it("updates agent status for valid transition", () => {
            const agents = new Map<string, AgentInfo>();
            agents.set("a1", makeAgent("a1"));

            setSwarmState({
                generation: 0,
                group: null,
                groupPath: "/tmp/test",
                agents,
                queenClients: new Map(),
            });

            const result = updateAgentStatus("a1", "done", { doneSummary: "completed work" });

            assert.equal(result, true);
            const agent = getSwarmState()!.agents.get("a1")!;
            assert.equal(agent.status, "done");
            assert.equal(agent.doneSummary, "completed work");
        });

        it("rejects invalid transition (crashed→running)", () => {
            const agents = new Map<string, AgentInfo>();
            agents.set("a1", makeAgent("a1", { status: "crashed" }));

            setSwarmState({
                generation: 0,
                group: null,
                groupPath: "/tmp/test",
                agents,
                queenClients: new Map(),
            });

            const result = updateAgentStatus("a1", "running");

            assert.equal(result, false);
            assert.equal(getSwarmState()!.agents.get("a1")!.status, "crashed");
        });

        it("rejects invalid transition (done→running)", () => {
            const agents = new Map<string, AgentInfo>();
            agents.set("a1", makeAgent("a1", { status: "done" }));

            setSwarmState({
                generation: 0,
                group: null,
                groupPath: "/tmp/test",
                agents,
                queenClients: new Map(),
            });

            const result = updateAgentStatus("a1", "running");
            assert.equal(result, false);
            assert.equal(getSwarmState()!.agents.get("a1")!.status, "done");
        });

        it("allows blocked→running (unblocked)", () => {
            const agents = new Map<string, AgentInfo>();
            agents.set("a1", makeAgent("a1", { status: "blocked" }));

            setSwarmState({
                generation: 0,
                group: null,
                groupPath: "/tmp/test",
                agents,
                queenClients: new Map(),
            });

            const result = updateAgentStatus("a1", "running");
            assert.equal(result, true);
            assert.equal(getSwarmState()!.agents.get("a1")!.status, "running");
        });

        it("returns false if agent not found", () => {
            const agents = new Map<string, AgentInfo>();
            agents.set("a1", makeAgent("a1"));

            setSwarmState({
                generation: 0,
                group: null,
                groupPath: "/tmp/test",
                agents,
                queenClients: new Map(),
            });

            const result = updateAgentStatus("nonexistent", "done");
            assert.equal(result, false);
            assert.equal(getSwarmState()!.agents.get("a1")!.status, "running");
        });

        it("fires onAllDone when all agents complete", () => {
            let allDoneFired = false;
            const agents = new Map<string, AgentInfo>();
            agents.set("a1", makeAgent("a1"));
            agents.set("a2", makeAgent("a2"));

            const state: SwarmState = {
                generation: 0,
                group: null,
                groupPath: "/tmp/test",
                agents,
                queenClients: new Map(),
            };
            state.onAllDone = () => { allDoneFired = true; };
            setSwarmState(state);

            updateAgentStatus("a1", "done");
            assert.equal(allDoneFired, false);

            updateAgentStatus("a2", "done");
            assert.equal(allDoneFired, true);
        });

        it("considers crashed/disconnected as finished for allDone check", () => {
            let allDoneFired = false;
            const agents = new Map<string, AgentInfo>();
            agents.set("a1", makeAgent("a1"));
            agents.set("a2", makeAgent("a2"));

            const state: SwarmState = {
                generation: 0,
                group: null,
                groupPath: "/tmp/test",
                agents,
                queenClients: new Map(),
            };
            state.onAllDone = () => { allDoneFired = true; };
            setSwarmState(state);

            updateAgentStatus("a1", "crashed");
            updateAgentStatus("a2", "disconnected");
            assert.equal(allDoneFired, true);
        });

        // ─── Idle state via updateAgentStatus ────────────────────

        it("running → idle via updateAgentStatus", () => {
            const agents = new Map<string, AgentInfo>();
            agents.set("a1", makeAgent("a1"));

            setSwarmState({
                generation: 0,
                group: null,
                groupPath: "/tmp/test",
                agents,
                queenClients: new Map(),
            });

            const result = updateAgentStatus("a1", "idle", { doneSummary: "task complete" });
            assert.equal(result, true);
            assert.equal(getSwarmState()!.agents.get("a1")!.status, "idle");
            assert.equal(getSwarmState()!.agents.get("a1")!.doneSummary, "task complete");
        });

        it("idle → running via updateAgentStatus (re-task)", () => {
            const agents = new Map<string, AgentInfo>();
            agents.set("a1", makeAgent("a1", { status: "idle" }));

            setSwarmState({
                generation: 0,
                group: null,
                groupPath: "/tmp/test",
                agents,
                queenClients: new Map(),
            });

            const result = updateAgentStatus("a1", "running");
            assert.equal(result, true);
            assert.equal(getSwarmState()!.agents.get("a1")!.status, "running");
        });

        it("idle → done via updateAgentStatus (dismiss)", () => {
            const agents = new Map<string, AgentInfo>();
            agents.set("a1", makeAgent("a1", { status: "idle" }));

            setSwarmState({
                generation: 0,
                group: null,
                groupPath: "/tmp/test",
                agents,
                queenClients: new Map(),
            });

            const result = updateAgentStatus("a1", "done", { doneSummary: "dismissed" });
            assert.equal(result, true);
            assert.equal(getSwarmState()!.agents.get("a1")!.status, "done");
            assert.equal(getSwarmState()!.agents.get("a1")!.doneSummary, "dismissed");
        });

        it("idle → blocked is rejected", () => {
            const agents = new Map<string, AgentInfo>();
            agents.set("a1", makeAgent("a1", { status: "idle" }));

            setSwarmState({
                generation: 0,
                group: null,
                groupPath: "/tmp/test",
                agents,
                queenClients: new Map(),
            });

            const result = updateAgentStatus("a1", "blocked");
            assert.equal(result, false);
            assert.equal(getSwarmState()!.agents.get("a1")!.status, "idle");
        });

        // ─── checkAllDone with idle ──────────────────────────────

        it("fires onAllDone when all agents are idle", () => {
            let allDoneFired = false;
            const agents = new Map<string, AgentInfo>();
            agents.set("a1", makeAgent("a1"));
            agents.set("a2", makeAgent("a2"));

            const state: SwarmState = {
                generation: 0,
                group: null,
                groupPath: "/tmp/test",
                agents,
                queenClients: new Map(),
            };
            state.onAllDone = () => { allDoneFired = true; };
            setSwarmState(state);

            updateAgentStatus("a1", "idle");
            assert.equal(allDoneFired, false);

            updateAgentStatus("a2", "idle");
            assert.equal(allDoneFired, true);
        });

        it("fires onAllDone with mix of idle + terminal states", () => {
            let allDoneFired = false;
            const agents = new Map<string, AgentInfo>();
            agents.set("a1", makeAgent("a1"));
            agents.set("a2", makeAgent("a2"));
            agents.set("a3", makeAgent("a3"));

            const state: SwarmState = {
                generation: 0,
                group: null,
                groupPath: "/tmp/test",
                agents,
                queenClients: new Map(),
            };
            state.onAllDone = () => { allDoneFired = true; };
            setSwarmState(state);

            updateAgentStatus("a1", "idle");
            assert.equal(allDoneFired, false);

            updateAgentStatus("a2", "crashed");
            assert.equal(allDoneFired, false);

            updateAgentStatus("a3", "done");
            assert.equal(allDoneFired, true);
        });

        it("does NOT fire onAllDone if any agent is still running", () => {
            let allDoneFired = false;
            const agents = new Map<string, AgentInfo>();
            agents.set("a1", makeAgent("a1"));
            agents.set("a2", makeAgent("a2"));

            const state: SwarmState = {
                generation: 0,
                group: null,
                groupPath: "/tmp/test",
                agents,
                queenClients: new Map(),
            };
            state.onAllDone = () => { allDoneFired = true; };
            setSwarmState(state);

            updateAgentStatus("a1", "idle");
            assert.equal(allDoneFired, false);
            // a2 is still "running" — onAllDone should NOT fire
        });

        it("does NOT fire onAllDone if any agent is starting", () => {
            let allDoneFired = false;
            const agents = new Map<string, AgentInfo>();
            agents.set("a1", makeAgent("a1", { status: "starting" }));
            agents.set("a2", makeAgent("a2"));

            const state: SwarmState = {
                generation: 0,
                group: null,
                groupPath: "/tmp/test",
                agents,
                queenClients: new Map(),
            };
            state.onAllDone = () => { allDoneFired = true; };
            setSwarmState(state);

            updateAgentStatus("a2", "idle");
            assert.equal(allDoneFired, false);
            // a1 is still "starting" — onAllDone should NOT fire
        });

        it("does NOT fire onAllDone if any agent is blocked", () => {
            let allDoneFired = false;
            const agents = new Map<string, AgentInfo>();
            agents.set("a1", makeAgent("a1"));
            agents.set("a2", makeAgent("a2"));

            const state: SwarmState = {
                generation: 0,
                group: null,
                groupPath: "/tmp/test",
                agents,
                queenClients: new Map(),
            };
            state.onAllDone = () => { allDoneFired = true; };
            setSwarmState(state);

            updateAgentStatus("a1", "blocked");
            updateAgentStatus("a2", "idle");
            assert.equal(allDoneFired, false);
            // a1 is "blocked" — onAllDone should NOT fire
        });
    });

    describe("parentClients", () => {
        it("starts with null", () => {
            assert.equal(getParentClients(), null);
        });

        it("sets and gets parent clients", () => {
            const clients = new Map();
            setParentClients(clients);
            assert.equal(getParentClients(), clients);
        });

        it("can be cleared back to null", () => {
            setParentClients(new Map());
            setParentClients(null);
            assert.equal(getParentClients(), null);
        });
    });

    describe("cleanupSwarm", () => {
        it("sets state to null", async () => {
            setSwarmState({
                generation: 0,
                group: null,
                groupPath: "/tmp/test",
                agents: new Map(),
                queenClients: new Map(),
            });

            await cleanupSwarm();
            assert.equal(getSwarmState(), null);
        });

        it("is safe to call when no swarm exists", async () => {
            await cleanupSwarm(); // Should not throw
            assert.equal(getSwarmState(), null);
        });
    });
});
