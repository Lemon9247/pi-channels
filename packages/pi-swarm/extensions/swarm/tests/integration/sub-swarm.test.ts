/**
 * Integration tests for sub-swarm / flat architecture.
 *
 * Tests the channel-level behavior of:
 * - Dynamic inbox addition via ChannelGroup.fromExisting()
 * - Message queuing for pre-connection messages
 * - Sub-agent inbox creation and communication
 * - canSpawn resolution
 * - spawnedBy tracking for recursive kill
 *
 * Does NOT spawn real pi processes — tests communication patterns directly.
 */

import { describe, it, after, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { ChannelGroup, ChannelClient, type Message } from "agent-channels";
import {
    createSwarmChannelGroup,
    connectToMultiple,
    connectToChannel,
    GENERAL_CHANNEL,
    QUEEN_INBOX,
    inboxName,
} from "../../core/channels.js";
import {
    setSwarmState,
    getSwarmState,
    updateAgentStatus,
    cleanupSwarm,
    type SwarmState,
    type AgentInfo,
} from "../../core/state.js";
import { resolveCanSpawn } from "../../core/agents.js";

function waitForMessage(client: ChannelClient, type?: string): Promise<Message> {
    return new Promise<Message>((resolve) => {
        const handler = (msg: Message) => {
            if (!type || msg.data?.type === type) {
                client.removeListener("message", handler);
                resolve(msg);
            }
        };
        client.on("message", handler);
    });
}

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

describe("sub-swarm: dynamic inbox addition", () => {
    let group: ChannelGroup;
    const allClients: ChannelClient[] = [];
    const extraGroups: ChannelGroup[] = [];

    afterEach(async () => {
        for (const client of allClients) {
            try { client.disconnect(); } catch { /* ignore */ }
        }
        allClients.length = 0;
        for (const g of extraGroups) {
            try { await g.stop(); } catch { /* ignore */ }
        }
        extraGroups.length = 0;
        try { await group?.stop({ removeDir: true }); } catch { /* ignore */ }
        await cleanupSwarm();
    });

    it("agent adds sub-agent inbox via fromExisting and sends instruction", async () => {
        // Queen creates initial group with one agent
        const { group: g } = await createSwarmChannelGroup(
            "sub-swarm-test-1",
            [{ name: "agent a1", swarm: "test" }],
        );
        group = g;

        // Agent a1 uses fromExisting to add sub-agent inbox
        const existingGroup = ChannelGroup.fromExisting(group.path);
        extraGroups.push(existingGroup);
        await existingGroup.addChannel({ name: inboxName("sub-1") });

        // Sub-agent connects to its inbox
        const subClient = await connectToChannel(group.path, inboxName("sub-1"));
        allClients.push(subClient);

        const msgPromise = waitForMessage(subClient, "instruct");

        // Queen sends instruction to sub-agent inbox
        const queenClient = await connectToChannel(group.path, inboxName("sub-1"));
        allClients.push(queenClient);
        queenClient.send({
            msg: "do subtask",
            data: { type: "instruct", from: "queen", instruction: "do subtask" },
        });

        const msg = await msgPromise;
        assert.equal(msg.data?.instruction, "do subtask");
    });

    it("message queuing: instruction sent before sub-agent connects is delivered", async () => {
        // Queen creates group
        const { group: g } = await createSwarmChannelGroup(
            "sub-swarm-test-2",
            [{ name: "agent a1", swarm: "test" }],
        );
        group = g;

        // Agent adds sub-agent inbox
        const existingGroup = ChannelGroup.fromExisting(group.path);
        extraGroups.push(existingGroup);
        await existingGroup.addChannel({ name: inboxName("sub-1") });

        // Send message BEFORE sub-agent connects (this is the race condition)
        const subInbox = existingGroup.channel(inboxName("sub-1"));
        subInbox.broadcast({
            msg: "early instruction",
            data: { type: "instruct", from: "agent a1", instruction: "early instruction" },
        });

        // Sub-agent connects later — should receive queued message
        const subClient = await connectToChannel(group.path, inboxName("sub-1"));
        allClients.push(subClient);

        const msg = await waitForMessage(subClient);
        assert.equal(msg.data?.instruction, "early instruction");
    });

    it("sub-agent communicates with queen via shared general channel", async () => {
        const { group: g } = await createSwarmChannelGroup(
            "sub-swarm-test-3",
            [{ name: "agent a1", swarm: "test" }],
        );
        group = g;

        // Add sub-agent inbox
        const existingGroup = ChannelGroup.fromExisting(group.path);
        extraGroups.push(existingGroup);
        await existingGroup.addChannel({ name: inboxName("sub-1") });

        // Queen monitors general
        const queenGeneral = await connectToChannel(group.path, GENERAL_CHANNEL);
        allClients.push(queenGeneral);

        // Sub-agent connects to general and sends a message
        const subGeneral = await connectToChannel(group.path, GENERAL_CHANNEL);
        allClients.push(subGeneral);

        const msgPromise = waitForMessage(queenGeneral, "message");

        subGeneral.send({
            msg: "sub-agent reporting",
            data: { type: "message", from: "sub-1", content: "sub-agent reporting" },
        });

        const msg = await msgPromise;
        assert.equal(msg.data?.from, "sub-1");
        assert.equal(msg.data?.content, "sub-agent reporting");
    });

    it("sub-agent sends done to queen inbox", async () => {
        const { group: g } = await createSwarmChannelGroup(
            "sub-swarm-test-4",
            [{ name: "agent a1", swarm: "test" }],
        );
        group = g;

        // Add sub-agent inbox
        const existingGroup = ChannelGroup.fromExisting(group.path);
        extraGroups.push(existingGroup);
        await existingGroup.addChannel({ name: inboxName("sub-1") });

        // Queen monitors queen inbox
        const queenInbox = await connectToChannel(group.path, QUEEN_INBOX);
        allClients.push(queenInbox);

        // Sub-agent sends done
        const subQueenInbox = await connectToChannel(group.path, QUEEN_INBOX);
        allClients.push(subQueenInbox);

        const donePromise = waitForMessage(queenInbox, "done");

        subQueenInbox.send({
            msg: "finished",
            data: { type: "done", from: "sub-1", summary: "sub-task complete" },
        });

        const msg = await donePromise;
        assert.equal(msg.data?.from, "sub-1");
        assert.equal(msg.data?.summary, "sub-task complete");
    });

    it("multiple sub-agents from different parents all share one group", async () => {
        const { group: g } = await createSwarmChannelGroup(
            "sub-swarm-test-5",
            [
                { name: "agent a1", swarm: "team-a" },
                { name: "agent a2", swarm: "team-b" },
            ],
        );
        group = g;

        // a1 adds sub-1, a2 adds sub-2
        const group1 = ChannelGroup.fromExisting(group.path);
        extraGroups.push(group1);
        await group1.addChannel({ name: inboxName("sub-1") });

        const group2 = ChannelGroup.fromExisting(group.path);
        extraGroups.push(group2);
        await group2.addChannel({ name: inboxName("sub-2") });

        // Both sub-agents connect to general
        const sub1 = await connectToChannel(group.path, GENERAL_CHANNEL);
        const sub2 = await connectToChannel(group.path, GENERAL_CHANNEL);
        allClients.push(sub1, sub2);

        // Queen monitors general
        const queen = await connectToChannel(group.path, GENERAL_CHANNEL);
        allClients.push(queen);

        // sub-1 sends, queen and sub-2 receive
        const queenPromise = waitForMessage(queen);
        const sub2Promise = waitForMessage(sub2);

        sub1.send({
            msg: "from sub-1",
            data: { type: "message", from: "sub-1", content: "from sub-1" },
        });

        const [queenMsg, sub2Msg] = await Promise.all([queenPromise, sub2Promise]);
        assert.equal(queenMsg.data?.from, "sub-1");
        assert.equal(sub2Msg.data?.from, "sub-1");
    });
});

describe("sub-swarm: canSpawn resolution integration", () => {
    it("inline canSpawn overrides archetype", () => {
        // No archetype (undefined agent name) — inline wins
        assert.equal(resolveCanSpawn(true, undefined, undefined), true);
        assert.equal(resolveCanSpawn(false, undefined, undefined), false);
    });

    it("defaults to false without any config", () => {
        assert.equal(resolveCanSpawn(undefined, undefined, undefined), false);
    });
});

describe("sub-swarm: spawnedBy tracking for recursive kill", () => {
    afterEach(async () => {
        await cleanupSwarm();
    });

    it("3-level hierarchy tracked correctly", () => {
        const agents: AgentInfo[] = [
            makeAgent("top", { spawnedBy: undefined }),
            makeAgent("mid-1", { spawnedBy: "top" }),
            makeAgent("mid-2", { spawnedBy: "top" }),
            makeAgent("leaf-1", { spawnedBy: "mid-1" }),
            makeAgent("leaf-2", { spawnedBy: "mid-1" }),
            makeAgent("leaf-3", { spawnedBy: "mid-2" }),
        ];

        const agentMap = new Map(agents.map(a => [a.name, a]));
        const state: SwarmState = {
            generation: 0,
            group: null,
            groupPath: "/tmp/fake",
            agents: agentMap,
            queenClients: new Map(),
            messages: [],
        };
        setSwarmState(state);

        // Find all descendants of "top"
        function findDescendants(name: string): string[] {
            const children = Array.from(agentMap.values())
                .filter(a => a.spawnedBy === name);
            const result: string[] = [];
            for (const child of children) {
                result.push(child.name);
                result.push(...findDescendants(child.name));
            }
            return result;
        }

        const topDescendants = findDescendants("top").sort();
        assert.deepEqual(topDescendants, ["leaf-1", "leaf-2", "leaf-3", "mid-1", "mid-2"]);

        const mid1Descendants = findDescendants("mid-1").sort();
        assert.deepEqual(mid1Descendants, ["leaf-1", "leaf-2"]);

        // Kill mid-1 subtree (mark disconnected)
        for (const name of ["leaf-1", "leaf-2", "mid-1"]) {
            updateAgentStatus(name, "disconnected");
        }

        assert.equal(agentMap.get("mid-1")!.status, "disconnected");
        assert.equal(agentMap.get("leaf-1")!.status, "disconnected");
        assert.equal(agentMap.get("leaf-2")!.status, "disconnected");
        // Others unaffected
        assert.equal(agentMap.get("top")!.status, "running");
        assert.equal(agentMap.get("mid-2")!.status, "running");
        assert.equal(agentMap.get("leaf-3")!.status, "running");
    });
});
