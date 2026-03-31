import { describe, it, after, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SharedChannel } from "../src/shared-channel.js";

function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "sc-test-"));
}

function wait(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

describe("SharedChannel", () => {
    let dir: string;
    const cleanups: (() => Promise<void>)[] = [];

    beforeEach(() => {
        dir = tmpDir();
    });

    afterEach(async () => {
        // Reverse order for clean shutdown
        for (const fn of cleanups.reverse()) {
            try { await fn(); } catch { /* ignore */ }
        }
        cleanups.length = 0;
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it("first joiner becomes server", async () => {
        const sockPath = path.join(dir, "test.sock");
        const sc = new SharedChannel(sockPath, { name: "Alpha" });
        cleanups.push(() => sc.leave());

        await sc.join();
        assert.equal(sc.role, "server");
        assert.equal(sc.joined, true);
        assert.deepEqual(sc.members, ["Alpha"]);
    });

    it("second joiner becomes client", async () => {
        const sockPath = path.join(dir, "test.sock");
        const sc1 = new SharedChannel(sockPath, { name: "Alpha" });
        const sc2 = new SharedChannel(sockPath, { name: "Beta" });
        cleanups.push(() => sc2.leave());
        cleanups.push(() => sc1.leave());

        await sc1.join();
        await sc2.join();

        assert.equal(sc1.role, "server");
        assert.equal(sc2.role, "client");
    });

    it("messages flow between server and client", async () => {
        const sockPath = path.join(dir, "test.sock");
        const sc1 = new SharedChannel(sockPath, { name: "Alpha", historySize: 10 });
        const sc2 = new SharedChannel(sockPath, { name: "Beta" });
        cleanups.push(() => sc2.leave());
        cleanups.push(() => sc1.leave());

        await sc1.join();
        await sc2.join();
        await wait(100); // Let identify messages propagate

        const received1: string[] = [];
        const received2: string[] = [];

        sc1.on("message", (msg) => received1.push(msg.msg));
        sc2.on("message", (msg) => received2.push(msg.msg));

        sc2.send({ msg: "hello from beta" });
        await wait(100);

        assert.ok(received1.some((m) => m === "hello from beta"), "Server should receive client message");

        sc1.send({ msg: "hello from alpha" });
        await wait(100);

        assert.ok(received2.some((m) => m === "hello from alpha"), "Client should receive server message");
    });

    it("emits join/leave events", async () => {
        const sockPath = path.join(dir, "test.sock");
        const sc1 = new SharedChannel(sockPath, { name: "Alpha" });
        const sc2 = new SharedChannel(sockPath, { name: "Beta" });
        cleanups.push(() => sc1.leave());

        await sc1.join();

        const joins: string[] = [];
        sc1.on("join", (name) => joins.push(name));
        const leaves: string[] = [];
        sc1.on("leave", (name) => leaves.push(name));

        await sc2.join();
        await wait(150);

        assert.ok(joins.includes("Beta"), "Should emit join for Beta");

        await sc2.leave();
        await wait(150);

        assert.ok(leaves.includes("Beta"), "Should emit leave for Beta");
    });

    it("tracks members correctly", async () => {
        const sockPath = path.join(dir, "test.sock");
        const sc1 = new SharedChannel(sockPath, { name: "Alpha" });
        const sc2 = new SharedChannel(sockPath, { name: "Beta" });
        cleanups.push(() => sc2.leave());
        cleanups.push(() => sc1.leave());

        await sc1.join();
        await sc2.join();
        await wait(150);

        const members1 = sc1.members;
        assert.ok(members1.includes("Alpha"));
        assert.ok(members1.includes("Beta"));
        assert.equal(members1.length, 2);
    });

    it("client promotes to server when server leaves", async () => {
        const sockPath = path.join(dir, "test.sock");
        const sc1 = new SharedChannel(sockPath, { name: "Alpha" });
        const sc2 = new SharedChannel(sockPath, { name: "Beta" });
        cleanups.push(() => sc2.leave());

        await sc1.join();
        assert.equal(sc1.role, "server");

        await sc2.join();
        assert.equal(sc2.role, "client");

        // Kill server
        await sc1.leave();
        await wait(500); // Wait for promotion

        assert.equal(sc2.role, "server");
        assert.equal(sc2.joined, true);
    });

    it("leave is idempotent", async () => {
        const sockPath = path.join(dir, "test.sock");
        const sc = new SharedChannel(sockPath, { name: "Alpha" });
        await sc.join();
        await sc.leave();
        await sc.leave(); // Should not throw
    });

    it("join is idempotent", async () => {
        const sockPath = path.join(dir, "test.sock");
        const sc = new SharedChannel(sockPath, { name: "Alpha" });
        cleanups.push(() => sc.leave());
        await sc.join();
        await sc.join(); // Should not throw
        assert.equal(sc.role, "server");
    });

    it("history replays to late joiners", async () => {
        const sockPath = path.join(dir, "test.sock");
        const sc1 = new SharedChannel(sockPath, { name: "Alpha", historySize: 50 });
        cleanups.push(() => sc1.leave());

        await sc1.join();

        // Send some messages (server broadcasts, which get buffered in history)
        sc1.send({ msg: "message 1", data: { type: "chat" } });
        sc1.send({ msg: "message 2", data: { type: "chat" } });
        await wait(50);

        // Late joiner
        const sc2 = new SharedChannel(sockPath, { name: "Beta" });
        cleanups.push(() => sc2.leave());

        const received: string[] = [];
        sc2.on("message", (msg) => received.push(msg.msg));

        await sc2.join();
        await wait(200);

        // Should have received the history
        assert.ok(received.includes("message 1"), `Expected "message 1" in ${JSON.stringify(received)}`);
        assert.ok(received.includes("message 2"), `Expected "message 2" in ${JSON.stringify(received)}`);
    });
});
