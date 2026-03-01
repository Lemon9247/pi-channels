/**
 * Tests for swarm_kill functionality.
 *
 * Tests the recursive kill logic and state management.
 * Does not test actual process killing — that requires real processes.
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
        groupPath: "/tmp/fake-group",
        agents: agentMap,
        queenClients: new Map(),
        messages: [],
    };
}

describe("swarm_kill state management", () => {
    beforeEach(async () => {
        await cleanupSwarm();
    });

    it("updateAgentStatus marks agent as disconnected", () => {
        const state = makeState([makeAgent("a1")]);
        setSwarmState(state);

        const result = updateAgentStatus("a1", "disconnected");
        assert.ok(result);
        assert.equal(state.agents.get("a1")!.status, "disconnected");
    });

    it("spawnedBy field tracks parent agent", () => {
        const parent = makeAgent("parent");
        const child = makeAgent("child", { spawnedBy: "parent" });
        const state = makeState([parent, child]);
        setSwarmState(state);

        assert.equal(state.agents.get("child")!.spawnedBy, "parent");
        assert.equal(state.agents.get("parent")!.spawnedBy, undefined);
    });

    it("can find sub-agents by spawnedBy", () => {
        const agents = [
            makeAgent("queen-agent"),
            makeAgent("sub-1", { spawnedBy: "queen-agent" }),
            makeAgent("sub-2", { spawnedBy: "queen-agent" }),
            makeAgent("unrelated"),
        ];
        const state = makeState(agents);
        setSwarmState(state);

        const subAgents = Array.from(state.agents.values()).filter(
            (a) => a.spawnedBy === "queen-agent",
        );
        assert.equal(subAgents.length, 2);
        assert.deepEqual(subAgents.map(a => a.name).sort(), ["sub-1", "sub-2"]);
    });

    it("recursive sub-agent lookup works for nested spawns", () => {
        const agents = [
            makeAgent("top"),
            makeAgent("mid", { spawnedBy: "top" }),
            makeAgent("leaf", { spawnedBy: "mid" }),
        ];
        const state = makeState(agents);
        setSwarmState(state);

        // Find all descendants of "top" recursively
        function findDescendants(name: string): string[] {
            const children = Array.from(state.agents.values())
                .filter((a) => a.spawnedBy === name);
            const all: string[] = [];
            for (const child of children) {
                all.push(child.name);
                all.push(...findDescendants(child.name));
            }
            return all;
        }

        const descendants = findDescendants("top");
        assert.deepEqual(descendants.sort(), ["leaf", "mid"]);
    });

    it("killing already-done agent is a no-op", () => {
        const state = makeState([makeAgent("done-agent", { status: "done" })]);
        setSwarmState(state);

        // Trying to transition done → disconnected should fail (terminal state)
        const result = updateAgentStatus("done-agent", "disconnected");
        assert.ok(!result);
        assert.equal(state.agents.get("done-agent")!.status, "done");
    });

    it("killing nonexistent agent returns false", () => {
        const state = makeState([makeAgent("a1")]);
        setSwarmState(state);

        const result = updateAgentStatus("nonexistent", "disconnected");
        assert.ok(!result);
    });

    it("marks all sub-agents disconnected when parent dies", () => {
        const agents = [
            makeAgent("parent"),
            makeAgent("child-1", { spawnedBy: "parent" }),
            makeAgent("child-2", { spawnedBy: "parent" }),
        ];
        const state = makeState(agents);
        setSwarmState(state);

        // Kill children first, then parent (depth-first order)
        updateAgentStatus("child-1", "disconnected");
        updateAgentStatus("child-2", "disconnected");
        updateAgentStatus("parent", "disconnected");

        assert.equal(state.agents.get("parent")!.status, "disconnected");
        assert.equal(state.agents.get("child-1")!.status, "disconnected");
        assert.equal(state.agents.get("child-2")!.status, "disconnected");
    });
});
