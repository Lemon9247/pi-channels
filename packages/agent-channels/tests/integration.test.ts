import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Mesh } from "../src/mesh.js";
import type { Message, MessageMeta } from "../src/index.js";

function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "mesh-int-test-"));
}

const cleanup: Array<{ leave?: () => Promise<void> }> = [];

afterEach(async () => {
    for (const item of cleanup) {
        try {
            if (item.leave) await item.leave();
        } catch { /* ignore */ }
    }
    cleanup.length = 0;
});

function track<T extends { leave?: () => Promise<void> }>(item: T): T {
    cleanup.push(item as any);
    return item;
}

function wait(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

describe("Integration", () => {
    it("multi-agent mesh: general chat + DMs", async () => {
        const dir = tmpDir();

        // Queen agent
        const queen = track(new Mesh({ name: "queen", dir }));
        await queen.join();
        await queen.joinChannel("general");
        queen.on("message", (msg: Message) => {
            void msg; // queen receives
        });

        // Worker agents
        const workers: Mesh[] = [];
        for (const name of ["a1", "a2", "a3"]) {
            const w = track(new Mesh({ name, dir }));
            await w.join();
            await w.joinChannel("general");
            workers.push(w);
        }

        await wait(100); // let joins propagate

        // a1 posts a finding to general
        const a1 = workers[0]!;
        const msgs: Array<{ msg: Message; meta: MessageMeta }> = [];
        queen.on("message", (msg, meta) => msgs.push({ msg, meta }));
        for (const w of workers.slice(1)) {
            w.on("message", () => { /* ignore */ });
        }

        a1.send("Found the bug in framing.ts", { channel: "general" });
        await wait(50);

        // Queen and a2, a3 should see it on general (sender excluded)
        assert.ok(msgs.some(m => m.meta.channel === "general"), "queen should see general message");

        // a2 sends blocker to queen via DM
        const dmReceived: Message[] = [];
        queen.on("message", (msg, meta) => {
            if (meta.channel === "dm") dmReceived.push(msg);
        });

        await a1.sendTo("queen", "Blocked on permissions — need sudo");
        await wait(50);

        assert.ok(dmReceived.some(m => m.msg.includes("Blocked")), "queen should receive DM");

        // Queen sends instruction to a3 via DM
        const a3Msgs: Message[] = [];
        const a3 = workers[2]!;
        a3.on("message", (msg, meta) => {
            if (meta.channel === "dm") a3Msgs.push(msg);
        });

        await queen.sendTo("a3", "Take over a2's task");
        await wait(50);

        assert.ok(a3Msgs.some(m => m.msg.includes("Take over")), "a3 should receive DM");

        // a3 signals done to general
        const generalDone: Message[] = [];
        for (const w of workers) {
            w.on("message", (msg, meta) => {
                if (meta.channel === "general") generalDone.push(msg);
            });
        }
        const queenGenMsgs: Message[] = [];
        queen.on("message", (msg, meta) => {
            if (meta.channel === "general") queenGenMsgs.push(msg);
        });

        await a3.send("Task complete", { channel: "general" });
        await wait(50);

        assert.ok(
            queenGenMsgs.some(m => m.msg.includes("Task complete")),
            "queen should see done on general"
        );
    });

    it("isolated meshes: same dir, different project dirs", async () => {
        const dir = tmpDir();
        const dir2 = tmpDir();

        // Two meshes in dir
        const m1a = track(new Mesh({ name: "m1a", dir }));
        const m1b = track(new Mesh({ name: "m1b", dir }));
        await m1a.join();
        await m1b.join();
        await wait(100);

        // Two meshes in dir2
        const m2a = track(new Mesh({ name: "m2a", dir: dir2 }));
        const m2b = track(new Mesh({ name: "m2b", dir: dir2 }));
        await m2a.join();
        await m2b.join();
        await wait(100);

        // m1a and m1b are on same mesh
        assert.ok(m1a.allMembers().includes("m1b"));
        assert.ok(m1b.allMembers().includes("m1a"));

        // m2a and m2b are on same mesh
        assert.ok(m2a.allMembers().includes("m2b"));
        assert.ok(m2b.allMembers().includes("m2a"));

        // Cross-mesh isolation is handled by projectDir in pi-channels extension
        // (agent-channels itself doesn't enforce isolation — that's the extension layer)
    });

    it("rapid message delivery: 500 messages", async () => {
        const dir = tmpDir();

        const sender = track(new Mesh({ name: "sender", dir }));
        const receiver = track(new Mesh({ name: "receiver", dir }));
        await sender.join();
        await receiver.join();
        await wait(100);

        const received: Message[] = [];
        receiver.on("message", (msg) => received.push(msg));

        const count = 500;
        for (let i = 0; i < count; i++) {
            sender.send(`msg-${i}`, { channel: "general" });
        }

        await Promise.race([
            (async () => {
                while (received.length < count) await wait(10);
            })(),
            new Promise<void>((_, reject) =>
                setTimeout(() => reject(new Error(
                    `Timeout: ${received.length}/${count} messages`
                )), 5000)
            ),
        ]);

        assert.equal(received.length, count);
        for (let i = 0; i < count; i++) {
            assert.equal(received[i]!.msg, `msg-${i}`);
        }
    });

    it("DM: multiple senders, one recipient", async () => {
        const dir = tmpDir();

        const recipient = track(new Mesh({ name: "recipient", dir }));
        const senders: Mesh[] = [];
        for (const name of ["s1", "s2", "s3"]) {
            const s = track(new Mesh({ name, dir }));
            await s.join();
            senders.push(s);
        }
        await recipient.join();
        await wait(100);

        const received: Message[] = [];
        recipient.on("message", (msg, meta) => {
            if (meta.channel === "dm") received.push(msg);
        });

        for (const s of senders) {
            await s.sendTo("recipient", `Report from ${s.name}`);
        }
        await wait(100);

        assert.equal(received.length, 3);
        const senders2 = received.map(m => m.msg.replace("Report from ", "")).sort();
        assert.deepEqual(senders2, ["s1", "s2", "s3"]);
    });

    it("stale socket cleanup", async () => {
        const dir = tmpDir();
        const sockPath = path.join(dir, "general.sock");

        // Create a stale file (not a socket)
        fs.writeFileSync(sockPath, "stale");

        // Mesh should clean it up on join
        const m = track(new Mesh({ name: "test", dir }));
        await m.join();
        await wait(50);

        // Mesh should be operational
        assert.equal(m.joined, true);
    });
});
