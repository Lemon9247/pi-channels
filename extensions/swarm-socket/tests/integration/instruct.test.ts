/**
 * Tests for swarm_instruct messaging
 *
 * Verifies that instructions reach the correct inbox channels.
 */

import { describe, it, after } from "node:test";
import * as assert from "node:assert/strict";
import { ChannelGroup, ChannelClient, type Message } from "../../../../../agent-channels/dist/index.js";
import {
    createSwarmChannelGroup,
    connectToChannel,
    connectToMultiple,
    GENERAL_CHANNEL,
    QUEEN_INBOX,
    inboxName,
} from "../../core/channels.js";

describe("instruct messaging", () => {
    let group: ChannelGroup;
    const cleanupClients: ChannelClient[] = [];

    after(async () => {
        for (const client of cleanupClients) {
            try { client.disconnect(); } catch { /* ignore */ }
        }
        try { await group.stop({ removeDir: true }); } catch { /* ignore */ }
    });

    it("sends targeted instruction to specific agent inbox", async () => {
        group = await createSwarmChannelGroup("instruct-test", ["a1", "a2"]);

        // Queen connects to all inboxes (simulating swarm.ts behavior)
        const queenClients = await connectToMultiple(group.path, [
            GENERAL_CHANNEL,
            QUEEN_INBOX,
            inboxName("a1"),
            inboxName("a2"),
        ]);
        for (const c of queenClients.values()) cleanupClients.push(c);

        // Agent a1 listens on its inbox
        const a1Inbox = await connectToChannel(group.path, inboxName("a1"));
        cleanupClients.push(a1Inbox);

        // Agent a2 listens on its inbox
        const a2Inbox = await connectToChannel(group.path, inboxName("a2"));
        cleanupClients.push(a2Inbox);

        // Expect a1 to receive, a2 to NOT receive
        const a1Received = new Promise<Message>((resolve) => {
            a1Inbox.on("message", (msg: Message) => {
                if (msg.data?.type === "instruct") resolve(msg);
            });
        });

        let a2GotInstruct = false;
        a2Inbox.on("message", (msg: Message) => {
            if (msg.data?.type === "instruct") {
                a2GotInstruct = true;
            }
        });

        // Queen sends instruct to a1's inbox
        queenClients.get(inboxName("a1"))!.send({
            msg: "check file X",
            data: { type: "instruct", from: "queen", instruction: "check file X", to: "a1" },
        });

        const msg = await a1Received;
        assert.equal(msg.data?.instruction, "check file X");

        // Wait a bit to ensure a2 doesn't receive it
        await new Promise((r) => setTimeout(r, 100));
        assert.equal(a2GotInstruct, false, "a2 should not receive a1's instruction");
    });

    it("broadcasts instruction to general channel", async () => {
        // Agent a1 and a2 listen on general
        const a1General = await connectToChannel(group.path, GENERAL_CHANNEL);
        const a2General = await connectToChannel(group.path, GENERAL_CHANNEL);
        cleanupClients.push(a1General, a2General);

        const queenClients = await connectToMultiple(group.path, [GENERAL_CHANNEL]);
        for (const c of queenClients.values()) cleanupClients.push(c);

        const a1Received = new Promise<Message>((resolve) => {
            a1General.on("message", (msg: Message) => {
                if (msg.data?.type === "instruct") resolve(msg);
            });
        });

        const a2Received = new Promise<Message>((resolve) => {
            a2General.on("message", (msg: Message) => {
                if (msg.data?.type === "instruct") resolve(msg);
            });
        });

        queenClients.get(GENERAL_CHANNEL)!.send({
            msg: "wrap up",
            data: { type: "instruct", from: "queen", instruction: "wrap up" },
        });

        const msg1 = await a1Received;
        const msg2 = await a2Received;
        assert.equal(msg1.data?.instruction, "wrap up");
        assert.equal(msg2.data?.instruction, "wrap up");
    });
});
