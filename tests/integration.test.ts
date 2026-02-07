import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { ChannelGroup } from "../src/group.js";
import { ChannelClient } from "../src/client.js";
import type { Message } from "../src/message.js";

function tmpGroupPath(suffix = ""): string {
    return path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), "int-test-")),
        `group${suffix}`
    );
}

const cleanupItems: Array<{ stop?: (opts?: any) => Promise<void>; disconnect?: () => void }> = [];

afterEach(async () => {
    for (const item of cleanupItems) {
        try {
            if (item.disconnect) item.disconnect();
            if (item.stop) await item.stop({ removeDir: true });
        } catch { /* ignore */ }
    }
    cleanupItems.length = 0;
});

function track<T extends { stop?: (opts?: any) => Promise<void>; disconnect?: () => void }>(item: T): T {
    cleanupItems.push(item as any);
    return item;
}

describe("Integration", () => {
    it("realistic swarm topology: general + 3 inboxes, 3 agents + queen", async () => {
        const groupPath = tmpGroupPath();
        const group = track(new ChannelGroup({
            path: groupPath,
            channels: [
                { name: "general" },
                { name: "inbox-queen", inbox: true },
                { name: "inbox-a1", inbox: true },
                { name: "inbox-a2", inbox: true },
                { name: "inbox-a3", inbox: true },
            ],
        }));
        await group.start();

        // Queen connects to general and all inboxes (reads everything)
        const queen = {
            general: track(new ChannelClient(path.join(groupPath, "general.sock"))),
            inbox: track(new ChannelClient(path.join(groupPath, "inbox-queen.sock"))),
        };
        await queen.general.connect();
        await queen.inbox.connect();

        // Each agent connects to general + their own inbox
        const agents: Array<{
            name: string;
            general: ChannelClient;
            inbox: ChannelClient;
        }> = [];

        for (const name of ["a1", "a2", "a3"]) {
            const agent = {
                name,
                general: track(new ChannelClient(path.join(groupPath, "general.sock"))),
                inbox: track(new ChannelClient(path.join(groupPath, `inbox-${name}.sock`))),
            };
            await agent.general.connect();
            await agent.inbox.connect();
            agents.push(agent);
        }

        // Collect messages
        const queenGeneralMsgs: Message[] = [];
        const queenInboxMsgs: Message[] = [];
        const agentMsgs: Map<string, Message[]> = new Map();

        queen.general.on("message", (msg: Message) => queenGeneralMsgs.push(msg));
        queen.inbox.on("message", (msg: Message) => queenInboxMsgs.push(msg));

        for (const agent of agents) {
            const msgs: Message[] = [];
            agentMsgs.set(agent.name, msgs);
            agent.general.on("message", (msg: Message) => msgs.push(msg));
            agent.inbox.on("message", (msg: Message) => msgs.push(msg));
        }

        // --- Scenario ---

        // 1. Agent a1 posts a finding to General
        agents[0]!.general.send({
            to: "general",
            msg: "Found the bug in framing.ts",
            data: { from: "a1", type: "finding" },
        });
        await new Promise((r) => setTimeout(r, 30));

        // Queen and other agents see it on General
        assert.equal(queenGeneralMsgs.length, 1);
        assert.equal(agentMsgs.get("a2")!.length, 1);
        assert.equal(agentMsgs.get("a3")!.length, 1);
        // a1 doesn't see its own message (sender excluded)
        assert.equal(agentMsgs.get("a1")!.length, 0);

        // 2. Agent a2 sends a blocker to queen's inbox
        const queenInboxClient = track(new ChannelClient(path.join(groupPath, "inbox-queen.sock")));
        await queenInboxClient.connect();
        queenInboxClient.send({
            to: "queen",
            msg: "Blocked on permissions — need sudo",
            data: { from: "a2", type: "blocker" },
        });
        await new Promise((r) => setTimeout(r, 30));

        assert.equal(queenInboxMsgs.length, 1);
        assert.equal(queenInboxMsgs[0]!.data!.type, "blocker");

        // 3. Queen sends instruction to a3's inbox
        const a3InboxClient = track(new ChannelClient(path.join(groupPath, "inbox-a3.sock")));
        await a3InboxClient.connect();
        a3InboxClient.send({
            to: "a3",
            msg: "Take over a2's task — they're blocked",
            data: { from: "queen", type: "instruction" },
        });
        await new Promise((r) => setTimeout(r, 30));

        // a3 receives the instruction on their inbox
        const a3Messages = agentMsgs.get("a3")!;
        assert.ok(a3Messages.some((m) => m.data?.type === "instruction"));

        // 4. Agent a3 signals done to queen inbox + general
        const doneMsg: Message = {
            to: "queen",
            msg: "Task complete — wrote findings to hive-mind",
            data: { from: "a3", type: "done" },
        };

        // Send to queen inbox
        const queenInboxClient2 = track(new ChannelClient(path.join(groupPath, "inbox-queen.sock")));
        await queenInboxClient2.connect();
        queenInboxClient2.send(doneMsg);

        // Also post to general
        agents[2]!.general.send({
            to: "general",
            msg: "Done — wrote findings",
            data: { from: "a3", type: "done" },
        });
        await new Promise((r) => setTimeout(r, 30));

        // Queen sees done on both channels
        assert.ok(queenInboxMsgs.some((m) => m.data?.type === "done"));
        assert.ok(queenGeneralMsgs.some((m) => m.data?.type === "done"));

        // Cleanup
        queenInboxClient.disconnect();
        queenInboxClient2.disconnect();
        a3InboxClient.disconnect();
        queen.general.disconnect();
        queen.inbox.disconnect();
        for (const agent of agents) {
            agent.general.disconnect();
            agent.inbox.disconnect();
        }
        await group.stop({ removeDir: true });
    });

    it("multiple groups running simultaneously", async () => {
        const group1Path = tmpGroupPath("-1");
        const group2Path = tmpGroupPath("-2");

        const group1 = track(new ChannelGroup({
            path: group1Path,
            channels: [{ name: "general" }, { name: "inbox-a1", inbox: true }],
        }));

        const group2 = track(new ChannelGroup({
            path: group2Path,
            channels: [{ name: "general" }, { name: "inbox-b1", inbox: true }],
        }));

        await group1.start();
        await group2.start();

        // Clients on group 1
        const g1c1 = track(new ChannelClient(path.join(group1Path, "general.sock")));
        const g1c2 = track(new ChannelClient(path.join(group1Path, "general.sock")));
        await g1c1.connect();
        await g1c2.connect();

        // Clients on group 2
        const g2c1 = track(new ChannelClient(path.join(group2Path, "general.sock")));
        const g2c2 = track(new ChannelClient(path.join(group2Path, "general.sock")));
        await g2c1.connect();
        await g2c2.connect();

        const g1received: Message[] = [];
        const g2received: Message[] = [];
        g1c2.on("message", (msg: Message) => g1received.push(msg));
        g2c2.on("message", (msg: Message) => g2received.push(msg));

        // Send on group 1 — should NOT appear on group 2
        g1c1.send({ to: "general", msg: "group 1 only" });
        // Send on group 2 — should NOT appear on group 1
        g2c1.send({ to: "general", msg: "group 2 only" });

        await new Promise((r) => setTimeout(r, 50));

        assert.equal(g1received.length, 1);
        assert.equal(g1received[0]!.msg, "group 1 only");
        assert.equal(g2received.length, 1);
        assert.equal(g2received[0]!.msg, "group 2 only");

        g1c1.disconnect(); g1c2.disconnect();
        g2c1.disconnect(); g2c2.disconnect();
        await group1.stop({ removeDir: true });
        await group2.stop({ removeDir: true });
    });

    it("runtime channel addition with active clients", async () => {
        const groupPath = tmpGroupPath();
        const group = track(new ChannelGroup({
            path: groupPath,
            channels: [{ name: "general" }],
        }));
        await group.start();

        // Client on general
        const generalClient = track(new ChannelClient(path.join(groupPath, "general.sock")));
        await generalClient.connect();

        // Add a topic channel at runtime
        await group.addChannel({ name: "topic-research" });

        // Client connects to the new channel
        const topicClient1 = track(new ChannelClient(path.join(groupPath, "topic-research.sock")));
        const topicClient2 = track(new ChannelClient(path.join(groupPath, "topic-research.sock")));
        await topicClient1.connect();
        await topicClient2.connect();

        const received: Message[] = [];
        topicClient2.on("message", (msg: Message) => received.push(msg));

        topicClient1.send({ to: "topic-research", msg: "research finding" });
        await new Promise((r) => setTimeout(r, 50));

        assert.equal(received.length, 1);
        assert.equal(received[0]!.msg, "research finding");

        generalClient.disconnect();
        topicClient1.disconnect();
        topicClient2.disconnect();
        await group.stop({ removeDir: true });
    });

    it("high-throughput message delivery", async () => {
        const groupPath = tmpGroupPath();
        const group = track(new ChannelGroup({
            path: groupPath,
            channels: [{ name: "firehose" }],
        }));
        await group.start();

        const sender = track(new ChannelClient(path.join(groupPath, "firehose.sock")));
        const receiver = track(new ChannelClient(path.join(groupPath, "firehose.sock")));
        await sender.connect();
        await receiver.connect();

        const messageCount = 500;
        const received: Message[] = [];

        const allReceived = new Promise<void>((resolve) => {
            receiver.on("message", (msg: Message) => {
                received.push(msg);
                if (received.length === messageCount) resolve();
            });
        });

        // Send 500 messages rapidly
        for (let i = 0; i < messageCount; i++) {
            sender.send({ to: "firehose", msg: `msg-${i}`, data: { seq: i } });
        }

        // Wait for all to arrive (with timeout)
        await Promise.race([
            allReceived,
            new Promise<void>((_, reject) =>
                setTimeout(() => reject(new Error(
                    `Timeout: received ${received.length}/${messageCount} messages`
                )), 5000)
            ),
        ]);

        assert.equal(received.length, messageCount);
        // Verify ordering is preserved (single sender)
        for (let i = 0; i < messageCount; i++) {
            assert.equal(received[i]!.data!.seq, i);
        }

        sender.disconnect();
        receiver.disconnect();
        await group.stop({ removeDir: true });
    });

    it("inbox pattern: multiple writers, one reader", async () => {
        const groupPath = tmpGroupPath();
        const group = track(new ChannelGroup({
            path: groupPath,
            channels: [{ name: "inbox-queen", inbox: true }],
        }));
        await group.start();

        // Queen reads their inbox
        const queenReader = track(new ChannelClient(path.join(groupPath, "inbox-queen.sock")));
        await queenReader.connect();

        const received: Message[] = [];
        queenReader.on("message", (msg: Message) => received.push(msg));

        // Three agents write to queen's inbox
        for (const agentName of ["a1", "a2", "a3"]) {
            const writer = new ChannelClient(path.join(groupPath, "inbox-queen.sock"));
            await writer.connect();
            writer.send({
                to: "queen",
                msg: `Report from ${agentName}`,
                data: { from: agentName },
            });
            // Small delay to let the message through before disconnect
            await new Promise((r) => setTimeout(r, 10));
            writer.disconnect();
        }

        await new Promise((r) => setTimeout(r, 50));

        assert.equal(received.length, 3);
        const senders = received.map((m) => m.data!.from).sort();
        assert.deepEqual(senders, ["a1", "a2", "a3"]);

        queenReader.disconnect();
        await group.stop({ removeDir: true });
    });
});
