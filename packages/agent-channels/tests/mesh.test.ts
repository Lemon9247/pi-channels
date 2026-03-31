import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Mesh } from "../src/mesh.js";
import { type Message } from "../src/message.js";

function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "mesh-test-"));
}

function wait(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

describe("Mesh", () => {
    let dir: string;
    const cleanups: (() => Promise<void>)[] = [];

    beforeEach(() => {
        dir = tmpDir();
    });

    afterEach(async () => {
        for (const fn of cleanups.reverse()) {
            try { await fn(); } catch { /* ignore */ }
        }
        cleanups.length = 0;
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it("joins and creates general channel + inbox", async () => {
        const mesh = new Mesh({ name: "Alpha", dir });
        cleanups.push(() => mesh.leave());

        await mesh.join();

        assert.equal(mesh.joined, true);
        assert.ok(mesh.channels.includes("general"));
        assert.ok(fs.existsSync(path.join(dir, "general.sock")));
        assert.ok(fs.existsSync(path.join(dir, "inbox-Alpha.sock")));
    });

    it("two meshes can communicate on general", async () => {
        const mesh1 = new Mesh({ name: "Alpha", dir });
        const mesh2 = new Mesh({ name: "Beta", dir });
        cleanups.push(() => mesh2.leave());
        cleanups.push(() => mesh1.leave());

        await mesh1.join();
        await mesh2.join();
        await wait(150);

        const received: { msg: string; channel: string; from: string }[] = [];
        mesh1.on("message", (msg, meta) => {
            received.push({ msg: msg.msg, channel: meta.channel, from: meta.from });
        });

        mesh2.send("hello from beta");
        await wait(150);

        assert.ok(
            received.some((r) => r.msg === "hello from beta" && r.from === "Beta" && r.channel === "general"),
            `Expected message from Beta on general, got: ${JSON.stringify(received)}`,
        );
    });

    it("supports topic channels", async () => {
        const mesh1 = new Mesh({ name: "Alpha", dir });
        const mesh2 = new Mesh({ name: "Beta", dir });
        cleanups.push(() => mesh2.leave());
        cleanups.push(() => mesh1.leave());

        await mesh1.join();
        await mesh2.join();
        await mesh1.join("testing");
        await mesh2.join("testing");
        await wait(150);

        const received: { msg: string; channel: string }[] = [];
        mesh1.on("message", (msg, meta) => {
            received.push({ msg: msg.msg, channel: meta.channel });
        });

        mesh2.send("tests green", { channel: "testing" });
        await wait(150);

        assert.ok(
            received.some((r) => r.msg === "tests green" && r.channel === "testing"),
            `Expected message on testing channel, got: ${JSON.stringify(received)}`,
        );
    });

    it("DMs work between meshes", async () => {
        const mesh1 = new Mesh({ name: "Alpha", dir });
        const mesh2 = new Mesh({ name: "Beta", dir });
        cleanups.push(() => mesh2.leave());
        cleanups.push(() => mesh1.leave());

        await mesh1.join();
        await mesh2.join();
        await wait(100);

        const received: { msg: string; from: string; channel: string }[] = [];
        mesh1.on("message", (msg, meta) => {
            received.push({ msg: msg.msg, from: meta.from, channel: meta.channel });
        });

        await mesh2.sendTo("Alpha", "private hello");
        await wait(150);

        assert.ok(
            received.some((r) => r.msg === "private hello" && r.from === "Beta" && r.channel === "dm"),
            `Expected DM from Beta, got: ${JSON.stringify(received)}`,
        );
    });

    it("emits join/leave events with channel name", async () => {
        const mesh1 = new Mesh({ name: "Alpha", dir });
        const mesh2 = new Mesh({ name: "Beta", dir });
        cleanups.push(() => mesh1.leave());

        await mesh1.join();

        const joins: { name: string; channel: string }[] = [];
        mesh1.on("join", (name, channel) => joins.push({ name, channel }));

        const leaves: { name: string; channel: string }[] = [];
        mesh1.on("leave", (name, channel) => leaves.push({ name, channel }));

        await mesh2.join();
        await wait(200);

        assert.ok(
            joins.some((j) => j.name === "Beta" && j.channel === "general"),
            `Expected join from Beta on general, got: ${JSON.stringify(joins)}`,
        );

        await mesh2.leave();
        await wait(200);

        assert.ok(
            leaves.some((l) => l.name === "Beta" && l.channel === "general"),
            `Expected leave from Beta on general, got: ${JSON.stringify(leaves)}`,
        );
    });

    it("lists members across channels", async () => {
        const mesh1 = new Mesh({ name: "Alpha", dir });
        const mesh2 = new Mesh({ name: "Beta", dir });
        cleanups.push(() => mesh2.leave());
        cleanups.push(() => mesh1.leave());

        await mesh1.join();
        await mesh2.join();
        await wait(150);

        const allMembers = mesh1.allMembers();
        assert.ok(allMembers.includes("Alpha"));
        assert.ok(allMembers.includes("Beta"));

        const generalMembers = mesh1.channelMembers("general");
        assert.ok(generalMembers.includes("Alpha"));
        assert.ok(generalMembers.includes("Beta"));
    });

    it("can leave a specific topic channel", async () => {
        const mesh = new Mesh({ name: "Alpha", dir });
        cleanups.push(() => mesh.leave());

        await mesh.join();
        await mesh.join("testing");

        assert.ok(mesh.channels.includes("testing"));

        await mesh.leave("testing");
        assert.ok(!mesh.channels.includes("testing"));
        assert.ok(mesh.channels.includes("general")); // Still in general
    });

    it("DM to offline agent throws", async () => {
        const mesh = new Mesh({ name: "Alpha", dir });
        cleanups.push(() => mesh.leave());

        await mesh.join();

        await assert.rejects(
            () => mesh.sendTo("Ghost", "hello"),
            /Cannot reach Ghost/,
        );
    });

    it("send to unjoined channel throws", () => {
        const mesh = new Mesh({ name: "Alpha", dir });
        assert.throws(
            () => mesh.send("hello", { channel: "nonexistent" }),
            /Not in channel/,
        );
    });
});
