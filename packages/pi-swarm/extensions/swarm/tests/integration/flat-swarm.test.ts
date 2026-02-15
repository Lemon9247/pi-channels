/**
 * Tests for flat swarm communication
 *
 * 3 agents + queen communicate via channels.
 * Tests the full communication pattern without process spawning.
 */

import { describe, it, after } from "node:test";
import * as assert from "node:assert/strict";
import { ChannelGroup, ChannelClient, type Message } from "agent-channels";
import {
    createSwarmChannelGroup,
    connectToChannel,
    connectToMultiple,
    GENERAL_CHANNEL,
    QUEEN_INBOX,
    inboxName,
} from "../../core/channels.js";

describe("flat swarm communication", () => {
    let group: ChannelGroup;
    const allClients: ChannelClient[] = [];

    after(async () => {
        for (const client of allClients) {
            try { client.disconnect(); } catch { /* ignore */ }
        }
        try { await group.stop({ removeDir: true }); } catch { /* ignore */ }
    });

    it("3 agents + queen full communication flow", async () => {
        const agentNames = ["agent a1", "agent a2", "agent a3"];
        const { group: g } = await createSwarmChannelGroup(
            "flat-swarm-test",
            agentNames.map((name) => ({ name, swarm: "test" })),
        );
        group = g;

        // Queen connects to all channels
        const queenChannels = [
            GENERAL_CHANNEL, QUEEN_INBOX,
            ...agentNames.map(inboxName),
        ];
        const queen = await connectToMultiple(group.path, queenChannels);
        for (const c of queen.values()) allClients.push(c);

        // Each agent connects to general + its inbox + queen inbox (for sending)
        const agents = new Map<string, Map<string, ChannelClient>>();
        for (const name of agentNames) {
            const channels = await connectToMultiple(group.path, [
                GENERAL_CHANNEL,
                inboxName(name),
                QUEEN_INBOX,
            ]);
            for (const c of channels.values()) allClients.push(c);
            agents.set(name, channels);
        }

        // === Test 1: Agent a1 sends message to general — all others see it ===
        const messagePromises = [
            waitForMessage(queen.get(GENERAL_CHANNEL)!, "message"),
            waitForMessage(agents.get("agent a2")!.get(GENERAL_CHANNEL)!, "message"),
            waitForMessage(agents.get("agent a3")!.get(GENERAL_CHANNEL)!, "message"),
        ];

        agents.get("agent a1")!.get(GENERAL_CHANNEL)!.send({
            msg: "Found the bug in connect()",
            data: { type: "message", from: "agent a1", content: "Found the bug in connect()" },
        });

        const [queenMsg, a2Msg, a3Msg] = await Promise.all(messagePromises);
        assert.equal(queenMsg.data?.from, "agent a1");
        assert.equal(a2Msg.data?.content, "Found the bug in connect()");
        assert.equal(a3Msg.data?.type, "message");

        // === Test 2: Agent a2 sends blocker to queen inbox ===
        const blockerPromise = waitForMessage(queen.get(QUEEN_INBOX)!, "blocker");

        agents.get("agent a2")!.get(QUEEN_INBOX)!.send({
            msg: "need help",
            data: { type: "blocker", from: "agent a2", description: "need help" },
        });

        const blockerMsg = await blockerPromise;
        assert.equal(blockerMsg.data?.from, "agent a2");
        assert.equal(blockerMsg.data?.description, "need help");

        // === Test 3: Queen sends instruct to agent a3's inbox ===
        const instructPromise = waitForMessage(agents.get("agent a3")!.get(inboxName("agent a3"))!, "instruct");

        queen.get(inboxName("agent a3"))!.send({
            msg: "focus on tests",
            data: { type: "instruct", from: "queen", instruction: "focus on tests" },
        });

        const instructMsg = await instructPromise;
        assert.equal(instructMsg.data?.instruction, "focus on tests");

        // === Test 4: All agents send done ===
        const donePromises: Promise<Message>[] = [];

        // Set up listener for 3 done messages on queen inbox
        let doneCount = 0;
        const allDone = new Promise<void>((resolve) => {
            queen.get(QUEEN_INBOX)!.on("message", (msg: Message) => {
                if (msg.data?.type === "done") {
                    doneCount++;
                    if (doneCount >= 3) resolve();
                }
            });
        });

        for (const name of agentNames) {
            agents.get(name)!.get(QUEEN_INBOX)!.send({
                msg: `${name} complete`,
                data: { type: "done", from: name, summary: `${name} complete` },
            });
        }

        await allDone;
        assert.equal(doneCount, 3);
    });
});

function waitForMessage(client: ChannelClient, type: string): Promise<Message> {
    return new Promise<Message>((resolve) => {
        const handler = (msg: Message) => {
            if (msg.data?.type === type) {
                client.removeListener("message", handler);
                resolve(msg);
            }
        };
        client.on("message", handler);
    });
}
