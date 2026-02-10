/**
 * Tests for core/channels.ts
 *
 * Verifies channel group creation, connection helpers, and cleanup.
 */

import { describe, it, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { ChannelGroup, ChannelClient } from "../../../../../agent-channels/dist/index.js";
import {
    createSwarmChannelGroup,
    connectToChannel,
    connectToMultiple,
    inboxName,
    topicName,
    groupPath,
    GENERAL_CHANNEL,
    QUEEN_INBOX,
    SWARM_BASE_DIR,
    type SwarmAgent,
} from "../../core/channels.js";

/** Helper: convert agent names to SwarmAgent[] (all in same swarm). */
function agents(names: string[], swarm = "default"): SwarmAgent[] {
    return names.map((name) => ({ name, swarm }));
}

describe("channels", () => {
    const cleanupGroups: ChannelGroup[] = [];
    const cleanupClients: ChannelClient[] = [];

    after(async () => {
        for (const client of cleanupClients) {
            try { client.disconnect(); } catch { /* ignore */ }
        }
        for (const group of cleanupGroups) {
            try { await group.stop({ removeDir: true }); } catch { /* ignore */ }
        }
    });

    describe("inboxName", () => {
        it("creates inbox name from agent name", () => {
            assert.equal(inboxName("agent a1"), "inbox-agent-a1");
        });

        it("handles simple names", () => {
            assert.equal(inboxName("scout"), "inbox-scout");
        });

        it("sanitizes special characters", () => {
            assert.equal(inboxName("agent/foo bar"), "inbox-agent-foo-bar");
        });
    });

    describe("groupPath", () => {
        it("builds path under SWARM_BASE_DIR", () => {
            const p = groupPath("test123");
            assert.equal(p, path.join(SWARM_BASE_DIR, "test123"));
        });
    });

    describe("createSwarmChannelGroup", () => {
        it("creates group with general + queen inbox + agent inboxes", async () => {
            const { group } = await createSwarmChannelGroup("test-create", agents(["agent a1", "agent a2"]));
            cleanupGroups.push(group);

            assert.equal(group.started, true);

            const channels = group.list();
            assert.ok(channels.includes(GENERAL_CHANNEL), "should have general channel");
            assert.ok(channels.includes(QUEEN_INBOX), "should have queen inbox");
            assert.ok(channels.includes("inbox-agent-a1"), "should have agent a1 inbox");
            assert.ok(channels.includes("inbox-agent-a2"), "should have agent a2 inbox");
            assert.equal(channels.length, 4);
        });

        it("creates group.json metadata", async () => {
            const { group } = await createSwarmChannelGroup("test-meta", agents(["scout"]));
            cleanupGroups.push(group);

            const metaPath = path.join(group.path, "group.json");
            assert.ok(fs.existsSync(metaPath), "group.json should exist");

            const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
            assert.ok(meta.channels.length === 3); // general, queen-inbox, inbox-scout
        });

        it("creates socket files", async () => {
            const { group } = await createSwarmChannelGroup("test-sockets", agents(["a1"]));
            cleanupGroups.push(group);

            const generalSock = path.join(group.path, "general.sock");
            const queenSock = path.join(group.path, "inbox-queen.sock");
            const a1Sock = path.join(group.path, "inbox-a1.sock");

            assert.ok(fs.existsSync(generalSock), "general.sock should exist");
            assert.ok(fs.existsSync(queenSock), "inbox-queen.sock should exist");
            assert.ok(fs.existsSync(a1Sock), "inbox-a1.sock should exist");
        });

        it("does not create topic channels for single swarm", async () => {
            const { group, topicChannels } = await createSwarmChannelGroup(
                "test-single-swarm",
                agents(["a1", "a2"], "alpha"),
            );
            cleanupGroups.push(group);

            assert.equal(topicChannels.size, 0, "single swarm should not create topic channels");
            assert.ok(!group.list().some((n) => n.startsWith("topic-")));
        });

        it("creates topic channels for multiple swarms", async () => {
            const multiAgents: SwarmAgent[] = [
                { name: "a1", swarm: "frontend" },
                { name: "a2", swarm: "frontend" },
                { name: "b1", swarm: "backend" },
            ];
            const { group, topicChannels } = await createSwarmChannelGroup("test-multi-swarm", multiAgents);
            cleanupGroups.push(group);

            assert.equal(topicChannels.size, 2);
            assert.equal(topicChannels.get("frontend"), "topic-frontend");
            assert.equal(topicChannels.get("backend"), "topic-backend");

            const channels = group.list();
            assert.ok(channels.includes("topic-frontend"), "should have frontend topic");
            assert.ok(channels.includes("topic-backend"), "should have backend topic");
            // general + queen + 3 inboxes + 2 topics = 7
            assert.equal(channels.length, 7);
        });
    });

    describe("topicName", () => {
        it("creates topic name from swarm name", () => {
            assert.equal(topicName("frontend"), "topic-frontend");
        });

        it("sanitizes special characters", () => {
            assert.equal(topicName("my team/alpha"), "topic-my-team-alpha");
        });
    });

    describe("connectToChannel", () => {
        it("connects a client to a channel", async () => {
            const { group } = await createSwarmChannelGroup("test-connect", agents(["a1"]));
            cleanupGroups.push(group);

            const client = await connectToChannel(group.path, GENERAL_CHANNEL);
            cleanupClients.push(client);

            assert.equal(client.connected, true);
        });
    });

    describe("connectToMultiple", () => {
        it("connects to multiple channels at once", async () => {
            const { group } = await createSwarmChannelGroup("test-multi", agents(["a1", "a2"]));
            cleanupGroups.push(group);

            const clients = await connectToMultiple(group.path, [GENERAL_CHANNEL, "inbox-a1"]);
            for (const c of clients.values()) cleanupClients.push(c);

            assert.equal(clients.size, 2);
            assert.ok(clients.get(GENERAL_CHANNEL)?.connected);
            assert.ok(clients.get("inbox-a1")?.connected);
        });
    });

    describe("cleanup", () => {
        it("group.stop removes directory when removeDir is true", async () => {
            const { group } = await createSwarmChannelGroup("test-cleanup", agents(["a1"]));
            const dirPath = group.path;

            assert.ok(fs.existsSync(dirPath));
            await group.stop({ removeDir: true });
            assert.ok(!fs.existsSync(dirPath));
        });
    });
});
