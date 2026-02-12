/**
 * Tests for swarm lifecycle
 *
 * Create swarm → channels created → clients connect → cleanup
 */

import { describe, it, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import { ChannelGroup, ChannelClient } from "agent-channels";
import {
    createSwarmChannelGroup,
    connectToChannel,
    connectToMultiple,
    GENERAL_CHANNEL,
    QUEEN_INBOX,
    inboxName,
} from "../../core/channels.js";

describe("swarm lifecycle", () => {
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

    it("creates group → connects queen → connects agents → sends messages → cleans up", async () => {
        // 1. Create channel group
        const { group } = await createSwarmChannelGroup("lifecycle-test", [
            { name: "a1", swarm: "test" },
            { name: "a2", swarm: "test" },
        ]);
        cleanupGroups.push(group);

        assert.equal(group.started, true);
        assert.equal(group.list().length, 4); // general, queen, a1, a2

        // 2. Queen connects to all channels
        const allChannels = [GENERAL_CHANNEL, QUEEN_INBOX, inboxName("a1"), inboxName("a2")];
        const queenClients = await connectToMultiple(group.path, allChannels);
        for (const c of queenClients.values()) cleanupClients.push(c);

        assert.equal(queenClients.size, 4);

        // 3. Agent a1 connects to general and its inbox
        const a1General = await connectToChannel(group.path, GENERAL_CHANNEL);
        const a1Inbox = await connectToChannel(group.path, inboxName("a1"));
        cleanupClients.push(a1General, a1Inbox);

        // 4. Agent a2 connects to general and its inbox
        const a2General = await connectToChannel(group.path, GENERAL_CHANNEL);
        const a2Inbox = await connectToChannel(group.path, inboxName("a2"));
        cleanupClients.push(a2General, a2Inbox);

        // 5. a1 sends done to queen inbox
        const queenInboxClient = queenClients.get(QUEEN_INBOX)!;
        const doneReceived = new Promise<void>((resolve) => {
            queenInboxClient.on("message", (msg) => {
                if (msg.data?.type === "done") resolve();
            });
        });

        // Connect a client to queen inbox to send the message
        const a1QueenSender = await connectToChannel(group.path, QUEEN_INBOX);
        cleanupClients.push(a1QueenSender);

        a1QueenSender.send({
            msg: "task complete",
            data: { type: "done", from: "a1", summary: "finished" },
        });

        await doneReceived;

        // 6. Queen sends instruct to a2's inbox
        const instructReceived = new Promise<void>((resolve) => {
            a2Inbox.on("message", (msg) => {
                if (msg.data?.type === "instruct") resolve();
            });
        });

        const queenA2Client = queenClients.get(inboxName("a2"))!;
        queenA2Client.send({
            msg: "do something else",
            data: { type: "instruct", from: "queen", instruction: "adjust approach" },
        });

        await instructReceived;

        // 7. Cleanup — disconnect all clients, stop group
        for (const c of cleanupClients) {
            try { c.disconnect(); } catch { /* ignore */ }
        }
        cleanupClients.length = 0;

        const groupPath = group.path;
        await group.stop({ removeDir: true });
        cleanupGroups.length = 0;

        assert.ok(!fs.existsSync(groupPath), "group directory should be removed");
    });
});
