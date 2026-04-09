import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Mesh } from "../src/mesh.js";

function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "mesh-test-"));
}

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Mesh", () => {
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

    it("joins general and creates a private DM inbox channel", async () => {
        const mesh = new Mesh({ name: "Alpha", dir });
        cleanups.push(() => mesh.leave());

        await mesh.join();

        assert.equal(mesh.joined, true);
        assert.deepEqual(mesh.channels, ["general"]);
        assert.ok(fs.existsSync(path.join(dir, "general.sock")));
        assert.ok(fs.existsSync(path.join(dir, "dm-Alpha.sock")));
    });

    it("two meshes can communicate on general", async () => {
        const alpha = new Mesh({ name: "Alpha", dir });
        const beta = new Mesh({ name: "Beta", dir });
        cleanups.push(() => beta.leave());
        cleanups.push(() => alpha.leave());

        await alpha.join();
        await beta.join();
        await wait(150);

        const received: Array<{ msg: string; channel: string; from: string }> = [];
        alpha.on("message", (msg, meta) => {
            received.push({ msg: msg.msg, channel: meta.channel, from: meta.from });
        });

        beta.send("hello from beta");
        await wait(150);

        assert.ok(received.some((entry) => entry.msg === "hello from beta" && entry.channel === "general" && entry.from === "Beta"));
    });

    it("supports topic channels", async () => {
        const alpha = new Mesh({ name: "Alpha", dir });
        const beta = new Mesh({ name: "Beta", dir });
        cleanups.push(() => beta.leave());
        cleanups.push(() => alpha.leave());

        await alpha.join();
        await beta.join();
        await alpha.join("testing");
        await beta.join("testing");
        await wait(150);

        const received: Array<{ msg: string; channel: string }> = [];
        alpha.on("message", (msg, meta) => {
            received.push({ msg: msg.msg, channel: meta.channel });
        });

        beta.send("tests green", { channel: "testing" });
        await wait(150);

        assert.ok(received.some((entry) => entry.msg === "tests green" && entry.channel === "testing"));
    });

    it("DMs work between meshes", async () => {
        const alpha = new Mesh({ name: "Alpha", dir });
        const beta = new Mesh({ name: "Beta", dir });
        cleanups.push(() => beta.leave());
        cleanups.push(() => alpha.leave());

        await alpha.join();
        await beta.join();
        await wait(100);

        const received: Array<{ msg: string; from: string; channel: string }> = [];
        alpha.on("message", (msg, meta) => {
            received.push({ msg: msg.msg, from: meta.from, channel: meta.channel });
        });

        await beta.sendTo("Alpha", "private hello");
        await wait(150);

        assert.ok(received.some((entry) => entry.msg === "private hello" && entry.from === "Beta" && entry.channel === "dm"));
    });

    it("emits join and leave events for communal channels", async () => {
        const alpha = new Mesh({ name: "Alpha", dir });
        const beta = new Mesh({ name: "Beta", dir });
        cleanups.push(() => alpha.leave());

        await alpha.join();

        const joins: Array<{ name: string; channel: string }> = [];
        const leaves: Array<{ name: string; channel: string }> = [];
        alpha.on("join", (name, channel) => joins.push({ name, channel }));
        alpha.on("leave", (name, channel) => leaves.push({ name, channel }));

        await beta.join();
        await wait(200);
        await beta.leave();
        await wait(200);

        assert.ok(joins.some((entry) => entry.name === "Beta" && entry.channel === "general"));
        assert.ok(leaves.some((entry) => entry.name === "Beta" && entry.channel === "general"));
        assert.equal(joins.some((entry) => entry.channel === "dm"), false);
    });

    it("lists members across communal channels only", async () => {
        const alpha = new Mesh({ name: "Alpha", dir });
        const beta = new Mesh({ name: "Beta", dir });
        cleanups.push(() => beta.leave());
        cleanups.push(() => alpha.leave());

        await alpha.join();
        await beta.join();
        await wait(150);

        const members = alpha.allMembers();
        assert.ok(members.includes("Alpha"));
        assert.ok(members.includes("Beta"));
    });

    it("can leave a specific topic channel", async () => {
        const mesh = new Mesh({ name: "Alpha", dir });
        cleanups.push(() => mesh.leave());

        await mesh.join();
        await mesh.join("testing");
        assert.ok(mesh.channels.includes("testing"));

        await mesh.leave("testing");
        assert.ok(!mesh.channels.includes("testing"));
        assert.ok(mesh.channels.includes("general"));
    });

    it("sendTo rejects when target is offline", async () => {
        const mesh = new Mesh({ name: "Alpha", dir });
        cleanups.push(() => mesh.leave());

        await mesh.join();
        await assert.rejects(() => mesh.sendTo("Ghost", "hello"), /Cannot reach Ghost/);
    });

    it("send to unjoined channel throws", async () => {
        const mesh = new Mesh({ name: "Alpha", dir });
        cleanups.push(() => mesh.leave());

        await mesh.join();
        assert.throws(() => mesh.send("hello", { channel: "nonexistent" }), /Not in channel/);
    });
});
