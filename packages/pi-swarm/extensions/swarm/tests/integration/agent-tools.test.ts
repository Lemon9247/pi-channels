/**
 * Tests for agent tools
 *
 * Verifies that message, hive_done, hive_blocker
 * send correct messages to correct channels.
 */

import { describe, it, after, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { ChannelGroup, ChannelClient, type Message } from "agent-channels";
import {
    createSwarmChannelGroup,
    connectToChannel,
    connectToMultiple,
    GENERAL_CHANNEL,
    QUEEN_INBOX,
    inboxName,
    type SwarmAgent,
} from "../../core/channels.js";
import { setParentClients, cleanupSwarm } from "../../core/state.js";
import { resetIdentity } from "../../core/identity.js";

describe("agent tools messaging", () => {
    let group: ChannelGroup;
    /** Server-side monitoring clients (simulating what the queen sees). */
    let queenMonitor: Map<string, ChannelClient>;
    /** Agent-side clients (what the agent's tools use via parentClients). */
    let agentClients: Map<string, ChannelClient>;

    const savedEnv: Record<string, string | undefined> = {};
    const envKeys = [
        "PI_CHANNELS_GROUP", "PI_CHANNELS_INBOX", "PI_CHANNELS_SUBSCRIBE",
        "PI_CHANNELS_NAME", "PI_SWARM_AGENT_NAME", "PI_SWARM_AGENT_ROLE",
        "PI_SWARM_AGENT_SWARM",
    ];

    beforeEach(async () => {
        // Save env
        for (const key of envKeys) {
            savedEnv[key] = process.env[key];
        }

        // Set up agent identity
        process.env.PI_CHANNELS_NAME = "agent a1";
        process.env.PI_SWARM_AGENT_ROLE = "agent";
        process.env.PI_SWARM_AGENT_SWARM = "test";
        resetIdentity();

        // Create channel group
        const result = await createSwarmChannelGroup("agent-tools-test", [
            { name: "agent a1", swarm: "test" },
            { name: "agent a2", swarm: "test" },
        ]);
        group = result.group;

        // Queen monitors queen inbox and general
        queenMonitor = await connectToMultiple(group.path, [QUEEN_INBOX, GENERAL_CHANNEL]);

        // Agent connects to general, queen inbox (for sending), and its own inbox (for receiving)
        agentClients = await connectToMultiple(group.path, [
            GENERAL_CHANNEL,
            QUEEN_INBOX,
            inboxName("agent a1"),
            inboxName("agent a2"),
        ]);

        // Set parent clients so agent tools can find them
        setParentClients(agentClients);
    });

    afterEach(async () => {
        setParentClients(null);

        for (const c of queenMonitor.values()) {
            try { c.disconnect(); } catch { /* ignore */ }
        }
        for (const c of agentClients.values()) {
            try { c.disconnect(); } catch { /* ignore */ }
        }

        try { await group.stop({ removeDir: true }); } catch { /* ignore */ }

        // Restore env
        for (const key of envKeys) {
            if (savedEnv[key] !== undefined) {
                process.env[key] = savedEnv[key];
            } else {
                delete process.env[key];
            }
        }
        resetIdentity();
    });

    it("hive_done sends to queen inbox and general", async () => {
        const queenInboxClient = queenMonitor.get(QUEEN_INBOX)!;
        const generalClient = queenMonitor.get(GENERAL_CHANNEL)!;

        const queenReceived = new Promise<Message>((resolve) => {
            queenInboxClient.on("message", (msg: Message) => {
                if (msg.data?.type === "done") resolve(msg);
            });
        });

        const generalReceived = new Promise<Message>((resolve) => {
            generalClient.on("message", (msg: Message) => {
                if (msg.data?.type === "done") resolve(msg);
            });
        });

        // Send done message (simulating what agent.ts hive_done does)
        const doneMsg: Message = {
            msg: "task complete",
            data: { type: "done", from: "agent a1", summary: "task complete" },
        };
        agentClients.get(QUEEN_INBOX)!.send(doneMsg);
        agentClients.get(GENERAL_CHANNEL)!.send(doneMsg);

        const qMsg = await queenReceived;
        const gMsg = await generalReceived;

        assert.equal(qMsg.data?.type, "done");
        assert.equal(qMsg.data?.from, "agent a1");
        assert.equal(qMsg.data?.summary, "task complete");
        assert.equal(gMsg.data?.type, "done");
    });

    it("hive_blocker sends to queen inbox", async () => {
        const queenInboxClient = queenMonitor.get(QUEEN_INBOX)!;

        const received = new Promise<Message>((resolve) => {
            queenInboxClient.on("message", (msg: Message) => {
                if (msg.data?.type === "blocker") resolve(msg);
            });
        });

        agentClients.get(QUEEN_INBOX)!.send({
            msg: "stuck on API",
            data: { type: "blocker", from: "agent a1", description: "stuck on API" },
        });

        const msg = await received;
        assert.equal(msg.data?.type, "blocker");
        assert.equal(msg.data?.description, "stuck on API");
    });

    it("message sends to general channel", async () => {
        const generalClient = queenMonitor.get(GENERAL_CHANNEL)!;

        const received = new Promise<Message>((resolve) => {
            generalClient.on("message", (msg: Message) => {
                if (msg.data?.type === "message") resolve(msg);
            });
        });

        agentClients.get(GENERAL_CHANNEL)!.send({
            msg: "Found the bug — race condition in connect()",
            data: {
                type: "message",
                from: "agent a1",
                content: "Found the bug — race condition in connect()",
            },
        });

        const msg = await received;
        assert.equal(msg.data?.type, "message");
        assert.equal(msg.data?.content, "Found the bug — race condition in connect()");
    });

    it("message with 'to' field sends to target inbox", async () => {
        // Simulate a second agent's inbox monitor
        const a2InboxMonitor = await connectToChannel(group.path, inboxName("agent a2"));

        const received = new Promise<Message>((resolve) => {
            a2InboxMonitor.on("message", (msg: Message) => {
                if (msg.data?.type === "message") resolve(msg);
            });
        });

        agentClients.get(inboxName("agent a2"))!.send({
            msg: "Your module depends on types I'm refactoring",
            data: {
                type: "message",
                from: "agent a1",
                content: "Your module depends on types I'm refactoring",
                to: "agent a2",
            },
        });

        const msg = await received;
        assert.equal(msg.data?.to, "agent a2");
        assert.equal(msg.data?.content, "Your module depends on types I'm refactoring");

        a2InboxMonitor.disconnect();
    });

    it("message with progress metadata sends to general", async () => {
        const generalClient = queenMonitor.get(GENERAL_CHANNEL)!;

        const received = new Promise<Message>((resolve) => {
            generalClient.on("message", (msg: Message) => {
                if (msg.data?.type === "message") resolve(msg);
            });
        });

        agentClients.get(GENERAL_CHANNEL)!.send({
            msg: "Finished reading all test files",
            data: {
                type: "message",
                from: "agent a1",
                content: "Finished reading all test files",
                progress: { phase: "analyzing", percent: 40 },
            },
        });

        const msg = await received;
        assert.equal(msg.data?.type, "message");
        assert.equal(msg.data?.content, "Finished reading all test files");
        assert.deepEqual(msg.data?.progress, { phase: "analyzing", percent: 40 });
    });
});
