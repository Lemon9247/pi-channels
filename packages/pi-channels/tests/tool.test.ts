import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Mesh } from "agent-channels";
import {
    executeAgentTool,
    executeChannelTool,
    executeMsgTool,
    executeReserveTool,
} from "../extensions/channels/tool.js";
import { DEFAULT_CONFIG } from "../extensions/channels/types.js";
import * as registry from "../extensions/channels/registry.js";

function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "tool-test-"));
}

describe("tools", () => {
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

    it("msg errors when mesh is not connected", async () => {
        const result = await executeMsgTool({ message: "hi" }, ctx());
        assert.ok(result.includes("❌"));
    });

    it("channel lists channels", async () => {
        mesh = new Mesh({ name: "TestAgent", dir });
        await mesh.join();
        registerAgent("TestAgent", [], mesh.channels);

        const result = await executeChannelTool({ action: "list" }, ctx());
        assert.ok(result.includes("general"));
    });

    it("channel joins and leaves topic channels", async () => {
        mesh = new Mesh({ name: "TestAgent", dir });
        await mesh.join();
        registerAgent("TestAgent", [], mesh.channels);

        const joinResult = await executeChannelTool({ action: "join", name: "testing" }, ctx());
        assert.ok(joinResult.includes("testing"));

        const leaveResult = await executeChannelTool({ action: "leave", name: "testing" }, ctx());
        assert.ok(leaveResult.includes("Left"));
    });

    it("channel prevents leaving general", async () => {
        mesh = new Mesh({ name: "TestAgent", dir });
        await mesh.join();
        registerAgent("TestAgent", [], mesh.channels);

        const result = await executeChannelTool({ action: "leave", name: "general" }, ctx());
        assert.ok(result.includes("❌"));
    });

    it("msg sends to a channel", async () => {
        mesh = new Mesh({ name: "TestAgent", dir });
        await mesh.join();
        registerAgent("TestAgent", [], mesh.channels);

        const result = await executeMsgTool({ message: "hello world" }, ctx());
        assert.ok(result.includes("✅"));
        assert.ok(result.includes("general"));
    });

    it("reserve reserves and releases paths", async () => {
        mesh = new Mesh({ name: "TestAgent", dir });
        await mesh.join();
        registerAgent("TestAgent", [], mesh.channels);

        const reserveResult = await executeReserveTool(
            { paths: ["src/auth/"], reason: "Refactoring" },
            ctx(),
        );
        assert.ok(reserveResult.includes("✅"));
        assert.ok(reserveResult.includes("src/auth/"));
        assert.equal(registry.getAgent("TestAgent")?.reservations.length, 1);

        const releaseResult = await executeReserveTool(
            { action: "release", paths: ["src/auth/"] },
            ctx(),
        );
        assert.ok(releaseResult.includes("✅"));
        assert.equal(registry.getAgent("TestAgent")?.reservations.length, 0);
    });

    it("reserve detects conflicts", async () => {
        mesh = new Mesh({ name: "TestAgent", dir });
        await mesh.join();
        registerAgent("TestAgent", [], mesh.channels);
        registerAgent("OtherAgent", [{
            paths: ["src/auth/"],
            reason: "Working on auth",
            agent: "OtherAgent",
            timestamp: new Date().toISOString(),
        }]);

        const result = await executeReserveTool(
            { paths: ["src/auth/login.ts"] },
            ctx(),
        );
        assert.ok(result.includes("❌"));
        assert.ok(result.includes("OtherAgent"));
        assert.ok(result.includes("msg({ to: \"OtherAgent\""));
    });

    it("agent shows status", async () => {
        mesh = new Mesh({ name: "TestAgent", dir });
        await mesh.join();
        registerAgent("TestAgent", [], mesh.channels);

        const result = await executeAgentTool({ action: "status" }, ctx());
        assert.ok(result.includes("TestAgent"));
        assert.ok(result.includes("general"));
    });

    it("agent shows whois data", async () => {
        registerAgent("OtherAgent", [{
            paths: ["src/auth/"],
            reason: "Working",
            agent: "OtherAgent",
            timestamp: new Date().toISOString(),
        }], ["general", "testing"]);

        const result = await executeAgentTool({ action: "whois", name: "OtherAgent" }, ctx());
        assert.ok(result.includes("OtherAgent"));
        assert.ok(result.includes("src/auth/"));
        assert.ok(result.includes("testing"));
    });

    it("agent rejects unknown action", async () => {
        const result = await executeAgentTool({ action: "nonexistent" }, ctx());
        assert.ok(result.includes("❌"));
        assert.ok(result.includes("Unknown action"));
    });

    it("msg requires message", async () => {
        mesh = new Mesh({ name: "TestAgent", dir });
        await mesh.join();
        registerAgent("TestAgent", [], mesh.channels);

        const result = await executeMsgTool({}, ctx());
        assert.ok(result.includes("❌"));
    });

    it("msg DM to offline target returns an error", async () => {
        mesh = new Mesh({ name: "TestAgent", dir });
        await mesh.join();
        registerAgent("TestAgent", [], mesh.channels);

        const result = await executeMsgTool({ to: "Ghost", message: "hello" }, ctx());
        assert.ok(result.includes("❌"));
        assert.ok(result.includes("Cannot reach Ghost"));
    });

    it("agent spawn without prompt returns error", async () => {
        const result = await executeAgentTool({ action: "spawn" }, ctx());
        assert.ok(result.includes("❌"));
    });
});
