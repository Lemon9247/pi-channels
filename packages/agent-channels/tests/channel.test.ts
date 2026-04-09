import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Channel } from "../src/channel.js";

function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "channel-test-"));
}

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Channel", () => {
    let dir: string;
    const cleanups: (() => Promise<void>)[] = [];

    beforeEach(() => {
        dir = tmpDir();
    });

    afterEach(async () => {
        for (const cleanup of cleanups.reverse()) {
            try { await cleanup(); } catch { /* ignore */ }
        }
        cleanups.length = 0;
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it("first joiner becomes server", async () => {
        const channel = new Channel({ path: path.join(dir, "general.sock"), name: "Alpha" });
        cleanups.push(() => channel.leave());

        await channel.join();

        assert.equal(channel.role, "server");
        assert.equal(channel.joined, true);
        assert.deepEqual(channel.members, ["Alpha"]);
        assert.ok(fs.existsSync(channel.path));
    });

    it("second joiner becomes client", async () => {
        const alpha = new Channel({ path: path.join(dir, "general.sock"), name: "Alpha" });
        const beta = new Channel({ path: path.join(dir, "general.sock"), name: "Beta" });
        cleanups.push(() => beta.leave());
        cleanups.push(() => alpha.leave());

        await alpha.join();
        await beta.join();

        assert.equal(alpha.role, "server");
        assert.equal(beta.role, "client");
    });

    it("messages flow between members", async () => {
        const alpha = new Channel({ path: path.join(dir, "general.sock"), name: "Alpha" });
        const beta = new Channel({ path: path.join(dir, "general.sock"), name: "Beta" });
        cleanups.push(() => beta.leave());
        cleanups.push(() => alpha.leave());

        await alpha.join();
        await beta.join();
        await wait(100);

        const alphaReceived: string[] = [];
        const betaReceived: string[] = [];
        alpha.on("message", (msg) => alphaReceived.push(msg.msg));
        beta.on("message", (msg) => betaReceived.push(msg.msg));

        beta.send({ msg: "hello from beta" });
        await wait(100);
        alpha.send({ msg: "hello from alpha" });
        await wait(100);

        assert.ok(alphaReceived.includes("hello from beta"));
        assert.ok(betaReceived.includes("hello from alpha"));
    });

    it("emits join and leave events", async () => {
        const alpha = new Channel({ path: path.join(dir, "general.sock"), name: "Alpha" });
        const beta = new Channel({ path: path.join(dir, "general.sock"), name: "Beta" });
        cleanups.push(() => alpha.leave());

        await alpha.join();

        const joins: string[] = [];
        const leaves: string[] = [];
        alpha.on("join", (name) => joins.push(name));
        alpha.on("leave", (name) => leaves.push(name));

        await beta.join();
        await wait(150);
        await beta.leave();
        await wait(150);

        assert.ok(joins.includes("Beta"));
        assert.ok(leaves.includes("Beta"));
    });

    it("tracks members", async () => {
        const alpha = new Channel({ path: path.join(dir, "general.sock"), name: "Alpha" });
        const beta = new Channel({ path: path.join(dir, "general.sock"), name: "Beta" });
        cleanups.push(() => beta.leave());
        cleanups.push(() => alpha.leave());

        await alpha.join();
        await beta.join();
        await wait(150);

        assert.deepEqual(new Set(alpha.members), new Set(["Alpha", "Beta"]));
        assert.deepEqual(new Set(beta.members), new Set(["Alpha", "Beta"]));
    });

    it("client promotes to server when the server leaves", async () => {
        const alpha = new Channel({ path: path.join(dir, "general.sock"), name: "Alpha" });
        const beta = new Channel({ path: path.join(dir, "general.sock"), name: "Beta" });
        cleanups.push(() => beta.leave());

        await alpha.join();
        await beta.join();
        assert.equal(beta.role, "client");

        await alpha.leave();
        await wait(600);

        assert.equal(beta.role, "server");
        assert.equal(beta.joined, true);
    });

    it("cleans stale sockets on join", async () => {
        const socketPath = path.join(dir, "general.sock");
        fs.writeFileSync(socketPath, "stale");

        const channel = new Channel({ path: socketPath, name: "Alpha" });
        cleanups.push(() => channel.leave());

        await channel.join();

        assert.equal(channel.role, "server");
        assert.ok(fs.existsSync(socketPath));
    });

    it("join and leave are idempotent", async () => {
        const channel = new Channel({ path: path.join(dir, "general.sock"), name: "Alpha" });
        await channel.join();
        await channel.join();
        await channel.leave();
        await channel.leave();
        assert.equal(channel.joined, false);
    });
});
