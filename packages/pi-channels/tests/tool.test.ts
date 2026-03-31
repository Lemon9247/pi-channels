import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Mesh } from "agent-channels";
import { executeTool } from "../extensions/channels/tool.js";
import { DEFAULT_CONFIG } from "../extensions/channels/types.js";
import * as reservations from "../extensions/channels/reservations.js";

function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "tool-test-"));
}

function wait(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

describe("tool", () => {
    let dir: string;
    let projectDir: string;
    let mesh: Mesh | null = null;

    beforeEach(() => {
        dir = tmpDir();
        projectDir = tmpDir();
        reservations.clearAllReservations();
    });

    afterEach(async () => {
        if (mesh) {
            await mesh.leave();
            mesh = null;
        }
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
        try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    const ctx = () => ({
        mesh,
        config: DEFAULT_CONFIG,
        agentName: "TestAgent",
        projectDir,
    });

    it("returns error when mesh not connected", async () => {
        const result = await executeTool({ action: "send", message: "hi" }, ctx());
        assert.ok(result.includes("❌"));
    });

    it("lists channels", async () => {
        mesh = new Mesh({ name: "TestAgent", dir });
        await mesh.join();

        const result = await executeTool({ action: "channels" }, ctx());
        assert.ok(result.includes("general"));
    });

    it("joins and leaves topic channels", async () => {
        mesh = new Mesh({ name: "TestAgent", dir });
        await mesh.join();

        const joinResult = await executeTool(
            { action: "join", channel: "testing" },
            ctx(),
        );
        assert.ok(joinResult.includes("testing"));

        const leaveResult = await executeTool(
            { action: "leave", channel: "testing" },
            ctx(),
        );
        assert.ok(leaveResult.includes("Left"));
    });

    it("prevents leaving general", async () => {
        mesh = new Mesh({ name: "TestAgent", dir });
        await mesh.join();

        const result = await executeTool(
            { action: "leave", channel: "general" },
            ctx(),
        );
        assert.ok(result.includes("❌"));
    });

    it("sends to channel", async () => {
        mesh = new Mesh({ name: "TestAgent", dir });
        await mesh.join();

        const result = await executeTool(
            { action: "send", message: "hello world" },
            ctx(),
        );
        assert.ok(result.includes("✅"));
        assert.ok(result.includes("general"));
    });

    it("reserves and releases paths", async () => {
        mesh = new Mesh({ name: "TestAgent", dir });
        await mesh.join();

        const reserveResult = await executeTool(
            { action: "reserve", paths: ["src/auth/"], reason: "Refactoring" },
            ctx(),
        );
        assert.ok(reserveResult.includes("✅"));
        assert.ok(reserveResult.includes("src/auth/"));

        const releaseResult = await executeTool(
            { action: "release", paths: ["src/auth/"] },
            ctx(),
        );
        assert.ok(releaseResult.includes("✅"));
    });

    it("detects reservation conflicts", async () => {
        mesh = new Mesh({ name: "TestAgent", dir });
        await mesh.join();

        // Someone else has a reservation
        reservations.createReservation("OtherAgent", ["src/auth/"], "Working on auth");

        const result = await executeTool(
            { action: "reserve", paths: ["src/auth/login.ts"] },
            ctx(),
        );
        assert.ok(result.includes("❌"));
        assert.ok(result.includes("OtherAgent"));
    });

    it("shows status", async () => {
        mesh = new Mesh({ name: "TestAgent", dir });
        await mesh.join();

        const result = await executeTool({ action: "status" }, ctx());
        assert.ok(result.includes("TestAgent"));
        assert.ok(result.includes("general"));
    });

    it("shows feed", async () => {
        // Write some feed events
        const feedModule = await import("../extensions/channels/feed.js");
        feedModule.appendEvent(projectDir, "join", "Alpha", "Joined");

        const result = await executeTool({ action: "feed" }, ctx());
        assert.ok(result.includes("Alpha"));
        assert.ok(result.includes("join"));
    });

    it("handles unknown action", async () => {
        const result = await executeTool({ action: "nonexistent" }, ctx());
        assert.ok(result.includes("❌"));
        assert.ok(result.includes("Unknown action"));
    });

    it("config.show returns config", async () => {
        const result = await executeTool({ action: "config.show" }, ctx());
        assert.ok(result.includes("chattiness"));
        assert.ok(result.includes("normal"));
    });

    it("send requires message", async () => {
        mesh = new Mesh({ name: "TestAgent", dir });
        await mesh.join();
        const result = await executeTool({ action: "send" }, ctx());
        assert.ok(result.includes("❌"));
    });

    it("spawn without prompt returns error", async () => {
        const result = await executeTool({ action: "spawn" }, ctx());
        assert.ok(result.includes("❌"));
    });
});
