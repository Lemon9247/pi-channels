import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Mesh } from "../src/mesh.js";
import type { Message, MessageMeta } from "../src/index.js";

function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "mesh-int-test-"));
}

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

const cleanup: Array<{ leave?: () => Promise<void> }> = [];

afterEach(async () => {
    for (const item of cleanup) {
        try { await item.leave?.(); } catch { /* ignore */ }
    }
    cleanup.length = 0;
});

function track<T extends { leave?: () => Promise<void> }>(item: T): T {
    cleanup.push(item);
    return item;
}

describe("integration", () => {
    it("supports general chat and direct messages in one mesh", async () => {
        const dir = tmpDir();
        const queen = track(new Mesh({ name: "queen", dir }));
        const a1 = track(new Mesh({ name: "a1", dir }));
        const a2 = track(new Mesh({ name: "a2", dir }));
        const a3 = track(new Mesh({ name: "a3", dir }));

        await queen.join();
        await a1.join();
        await a2.join();
        await a3.join();
        await wait(150);

        const queenGeneral: Array<{ msg: Message; meta: MessageMeta }> = [];
        queen.on("message", (msg, meta) => {
            if (meta.channel === "general") {
                queenGeneral.push({ msg, meta });
            }
        });

        a1.send("Found the bug in framing.ts", { channel: "general" });
        await wait(100);
        assert.ok(queenGeneral.some((entry) => entry.msg.msg.includes("Found the bug")));

        const queenDms: Message[] = [];
        queen.on("message", (msg, meta) => {
            if (meta.channel === "dm") {
                queenDms.push(msg);
            }
        });

        await a2.sendTo("queen", "Blocked on permissions");
        await wait(100);
        assert.ok(queenDms.some((msg) => msg.msg.includes("Blocked")));

        const a3Dms: Message[] = [];
        a3.on("message", (msg, meta) => {
            if (meta.channel === "dm") {
                a3Dms.push(msg);
            }
        });

        await queen.sendTo("a3", "Take over a2's task");
        await wait(100);
        assert.ok(a3Dms.some((msg) => msg.msg.includes("Take over")));
    });

    it("handles rapid delivery on general", async () => {
        const dir = tmpDir();
        const sender = track(new Mesh({ name: "sender", dir }));
        const receiver = track(new Mesh({ name: "receiver", dir }));

        await sender.join();
        await receiver.join();
        await wait(100);

        const received: Message[] = [];
        receiver.on("message", (msg, meta) => {
            if (meta.channel === "general") {
                received.push(msg);
            }
        });

        const count = 500;
        for (let i = 0; i < count; i++) {
            sender.send(`msg-${i}`, { channel: "general" });
        }

        await Promise.race([
            (async () => {
                while (received.length < count) {
                    await wait(10);
                }
            })(),
            new Promise<void>((_resolve, reject) => {
                setTimeout(() => reject(new Error(`Timeout: ${received.length}/${count} messages`)), 5000);
            }),
        ]);

        assert.equal(received.length, count);
        for (let i = 0; i < count; i++) {
            assert.equal(received[i]!.msg, `msg-${i}`);
        }
    });
});
