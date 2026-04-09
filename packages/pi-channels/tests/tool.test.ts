import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Mesh } from "agent-channels";
import { executeTool } from "../extensions/channels/tool.js";
import { DEFAULT_CONFIG } from "../extensions/channels/types.js";
import * as registry from "../extensions/channels/registry.js";

function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "tool-test-"));
}

describe("tool", () => {
    let dir: string;
    let projectDir: string;
    let mesh: Mesh | null = null;

    beforeEach(() => {
        dir = tmpDir();
        projectDir = tmpDir();
    });

    afterEach(async () => {
        if (mesh) {
            await mesh.leave();
            mesh = null;
        }
        registry.unregisterAgent("TestAgent");
        registry.unregisterAgent("OtherAgent");
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
        try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    const ctx = () => ({
        mesh,
        config: DEFAULT_CONFIG,
        agentName: "TestAgent",
        projectDir,
    });

    function registerAgent(name: string, reservations: any[] = [], channels: string[] = ["general"]): void {
        registry.registerAgent({
            name,
            pid: process.pid,
            cwd: projectDir,
            reservations,
            joinedAt: new Date().toISOString(),
            lastActivity: new Date().toISOString(),
            status: "active",
            channels,
        });
    }

    it("returns error when mesh is not connected", async () => {
        const result = await executeTool({ action: "send", message: "hi" }, ctx());
        assert.ok(result.includes("❌"));
    });

    it("lists channels", async () => {
        mesh = new Mesh({ name: "TestAgent", dir });
        await mesh.join();
        registerAgent("TestAgent", [], mesh.channels);

        const result = await executeTool({ action: "channels" }, ctx());
        assert.ok(result.includes("general"));
    });

    it("joins and leaves topic channels", async () => {
        mesh = new Mesh({ name: "TestAgent", dir });
        await mesh.join();
        registerAgent("TestAgent", [], mesh.channels);

        const joinResult = await executeTool({ action: "join", channel: "testing" }, ctx());
        assert.ok(joinResult.includes("testing"));

        const leaveResult = await executeTool({ action: "leave", channel: "testing" }, ctx());
        assert.ok(leaveResult.includes("Left"));
    });

    it("prevents leaving general", async () => {
        mesh = new Mesh({ name: "TestAgent", dir });
        await mesh.join();
        registerAgent("TestAgent", [], mesh.channels);

        const result = await executeTool({ action: "leave", channel: "general" }, ctx());
        assert.ok(result.includes("❌"));
    });

    it("sends to a channel", async () => {
        mesh = new Mesh({ name: "TestAgent", dir });
        await mesh.join();
        registerAgent("TestAgent", [], mesh.channels);

        const result = await executeTool({ action: "send", message: "hello world" }, ctx());
        assert.ok(result.includes("✅"));
        assert.ok(result.includes("general"));
    });

    it("reserves and releases paths", async () => {
        mesh = new Mesh({ name: "TestAgent", dir });
        await mesh.join();
        registerAgent("TestAgent", [], mesh.channels);

        const reserveResult = await executeTool(
            { action: "reserve", paths: ["src/auth/"], reason: "Refactoring" },
            ctx(),
        );
        assert.ok(reserveResult.includes("✅"));
        assert.ok(reserveResult.includes("src/auth/"));
        assert.equal(registry.getAgent("TestAgent")?.reservations.length, 1);

        const releaseResult = await executeTool(
            { action: "release", paths: ["src/auth/"] },
            ctx(),
        );
        assert.ok(releaseResult.includes("✅"));
        assert.equal(registry.getAgent("TestAgent")?.reservations.length, 0);
    });

    it("detects reservation conflicts", async () => {
        mesh = new Mesh({ name: "TestAgent", dir });
        await mesh.join();
        registerAgent("TestAgent", [], mesh.channels);
        registerAgent("OtherAgent", [{
            paths: ["src/auth/"],
            reason: "Working on auth",
            agent: "OtherAgent",
            timestamp: new Date().toISOString(),
        }]);

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
        registerAgent("TestAgent", [], mesh.channels);

        const result = await executeTool({ action: "status" }, ctx());
        assert.ok(result.includes("TestAgent"));
        assert.ok(result.includes("general"));
    });

    it("shows whois data", async () => {
        registerAgent("OtherAgent", [{
            paths: ["src/auth/"],
            reason: "Working",
            agent: "OtherAgent",
            timestamp: new Date().toISOString(),
        }], ["general", "testing"]);

        const result = await executeTool({ action: "whois", name: "OtherAgent" }, ctx());
        assert.ok(result.includes("OtherAgent"));
        assert.ok(result.includes("src/auth/"));
        assert.ok(result.includes("testing"));
    });

    it("handles unknown action", async () => {
        const result = await executeTool({ action: "nonexistent" }, ctx());
        assert.ok(result.includes("❌"));
        assert.ok(result.includes("Unknown action"));
    });

    it("send requires message", async () => {
        mesh = new Mesh({ name: "TestAgent", dir });
        await mesh.join();
        registerAgent("TestAgent", [], mesh.channels);

        const result = await executeTool({ action: "send" }, ctx());
        assert.ok(result.includes("❌"));
    });

    it("spawn without prompt returns error", async () => {
        const result = await executeTool({ action: "spawn" }, ctx());
        assert.ok(result.includes("❌"));
    });
});
