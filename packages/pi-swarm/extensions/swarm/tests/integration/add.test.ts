/**
 * Tests for swarm_add: dynamic agent addition
 *
 * Tests the state and channel mechanics of adding agents mid-swarm.
 * Does not test actual process spawning — focuses on:
 * - State management (agents map, name collisions)
 * - Channel creation (inbox for new agents)
 * - checkAllDone behavior with dynamically added agents
 */

import { describe, it, beforeEach, after } from "node:test";
import * as assert from "node:assert/strict";
import { ChannelGroup, ChannelClient } from "agent-channels";
import {
    createSwarmChannelGroup,
    connectToChannel,
    connectToMultiple,
    GENERAL_CHANNEL,
    QUEEN_INBOX,
    inboxName,
} from "../../core/channels.js";
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

describe("swarm_add state management", () => {
    beforeEach(async () => {
        await cleanupSwarm();
    });

    it("rejects when no active swarm exists", () => {
        assert.equal(getSwarmState(), null);
        // swarm_add would check getSwarmState() and return error
    });

    it("detects name collisions with existing agents", () => {
        const agents = new Map<string, AgentInfo>();
        agents.set("scout-1", makeAgent("scout-1"));
        agents.set("worker-1", makeAgent("worker-1"));

        setSwarmState({
            generation: 0,
            group: null,
            groupPath: "/tmp/test",
            agents,
            queenClients: new Map(),
            messages: [],
        });

        const state = getSwarmState()!;
        // Check collision detection
        assert.ok(state.agents.has("scout-1"));
        assert.ok(!state.agents.has("scout-2"));
    });

    it("dynamically added agent participates in checkAllDone", () => {
        let allDoneFired = false;
        const agents = new Map<string, AgentInfo>();
        agents.set("scout-1", makeAgent("scout-1"));

        const state: SwarmState = {
            generation: 0,
            group: null,
            groupPath: "/tmp/test",
            agents,
            queenClients: new Map(),
            messages: [],
        };
        state.onAllDone = () => { allDoneFired = true; };
        setSwarmState(state);

        // Simulate dynamic add — add agent directly to state
        state.agents.set("scout-2", makeAgent("scout-2", { status: "starting" }));

        // First agent finishes — allDone should NOT fire
        updateAgentStatus("scout-1", "done");
        assert.equal(allDoneFired, false, "should not fire with scout-2 still starting");

        // Second agent finishes — allDone should fire
        updateAgentStatus("scout-2", "running");
        updateAgentStatus("scout-2", "done");
        assert.equal(allDoneFired, true, "should fire when all direct agents done");
    });

    it("dynamically added agent does not block allDone if it was already about to fire", () => {
        let allDoneCount = 0;
        const agents = new Map<string, AgentInfo>();
        agents.set("scout-1", makeAgent("scout-1"));

        const state: SwarmState = {
            generation: 0,
            group: null,
            groupPath: "/tmp/test",
            agents,
            queenClients: new Map(),
            messages: [],
        };
        state.onAllDone = () => { allDoneCount++; };
        setSwarmState(state);

        // Add a second agent before first finishes
        state.agents.set("scout-2", makeAgent("scout-2", { status: "starting" }));

        // Both finish
        updateAgentStatus("scout-1", "done");
        updateAgentStatus("scout-2", "done");

        assert.equal(allDoneCount, 1, "onAllDone should fire exactly once");
    });
});

describe("swarm_add channel creation", () => {

    it("creates inbox channel, queen connects, new agent registers", async () => {
        const clients: ChannelClient[] = [];
        // Start with a 1-agent swarm
        const { group } = await createSwarmChannelGroup(
            "add-test-1",
            [{ name: "scout-1", swarm: "test" }],
        );

        try {
            // Queen connects to initial channels
            const queenClients = await connectToMultiple(group.path, [
                GENERAL_CHANNEL,
                QUEEN_INBOX,
                inboxName("scout-1"),
            ]);
            for (const c of queenClients.values()) clients.push(c);

            // Dynamically add a new inbox channel (simulating swarm_add)
            await group.addChannel({ name: inboxName("scout-2") });

            // Queen connects to the new inbox
            const newInboxClient = await connectToChannel(group.path, inboxName("scout-2"));
            clients.push(newInboxClient);

            // New agent connects to its inbox + general + queen inbox
            const newAgentClients = await connectToMultiple(group.path, [
                GENERAL_CHANNEL,
                inboxName("scout-2"),
                QUEEN_INBOX,
            ]);
            for (const c of newAgentClients.values()) clients.push(c);

            // New agent can send to queen via QUEEN_INBOX
            const registerPromise = new Promise<void>((resolve) => {
                queenClients.get(QUEEN_INBOX)!.on("message", (msg) => {
                    if (msg.data?.type === "register" && msg.data?.from === "scout-2") {
                        resolve();
                    }
                });
            });

            newAgentClients.get(QUEEN_INBOX)!.send({
                msg: "register",
                data: { type: "register", from: "scout-2", role: "agent" },
            });

            await registerPromise;

            // Queen can instruct new agent via its inbox
            const instructPromise = new Promise<string>((resolve) => {
                // New agent listening on its inbox via newAgentClients
                newAgentClients.get(inboxName("scout-2"))!.on("message", (msg) => {
                    if (msg.data?.type === "instruct") {
                        resolve(msg.data.instruction as string);
                    }
                });
            });

            newInboxClient.send({
                msg: "focus on tests",
                data: { type: "instruct", from: "queen", instruction: "focus on tests" },
            });

            const instruction = await instructPromise;
            assert.equal(instruction, "focus on tests");
        } finally {
            for (const c of clients) { try { c.disconnect(); } catch {} }
            try { await group.stop({ removeDir: true }); } catch {}
        }
    });

    it("agent_added broadcast reaches existing agents on general", async () => {
        const clients: ChannelClient[] = [];
        const { group } = await createSwarmChannelGroup(
            "add-test-2",
            [{ name: "scout-1", swarm: "test" }],
        );

        try {
            // Existing agent listens on general
            const existingAgentGeneral = await connectToChannel(group.path, GENERAL_CHANNEL);
            clients.push(existingAgentGeneral);

            const addedPromise = new Promise<string>((resolve) => {
                existingAgentGeneral.on("message", (msg) => {
                    if (msg.data?.type === "agent_added") {
                        resolve(msg.data.agent as string);
                    }
                });
            });

            // Queen broadcasts agent_added (as swarm_add would)
            const queenGeneral = await connectToChannel(group.path, GENERAL_CHANNEL);
            clients.push(queenGeneral);

            queenGeneral.send({
                msg: "New agent joined: scout-3",
                data: {
                    type: "agent_added",
                    from: "system",
                    agent: "scout-3",
                    task: "investigate logs",
                    swarm: "test",
                },
            });

            const addedAgent = await addedPromise;
            assert.equal(addedAgent, "scout-3");
        } finally {
            for (const c of clients) { try { c.disconnect(); } catch {} }
            try { await group.stop({ removeDir: true }); } catch {}
        }
    });
});
