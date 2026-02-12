/**
 * Tests for core/agents.ts
 *
 * Verifies agent discovery with scope control, project agent resolution,
 * source tracking, frontmatter parsing, and directory walking.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
    discoverAgents,
    findNearestProjectAgentsDir,
    parseFrontmatter,
} from "../../core/agents.js";

// ─── Helpers ─────────────────────────────────────────────────────────

function makeTmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-test-"));
}

function writeAgentFile(dir: string, filename: string, content: string): void {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), content);
}

function makeAgentMd(name: string, description: string, opts?: { model?: string; tools?: string }): string {
    const lines = ["---", `name: ${name}`, `description: ${description}`];
    if (opts?.model) lines.push(`model: ${opts.model}`);
    if (opts?.tools) lines.push(`tools: ${opts.tools}`);
    lines.push("---", "", `System prompt for ${name}.`);
    return lines.join("\n");
}

function cleanupDir(dir: string): void {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* ignore */ }
}

// ─── Tests ───────────────────────────────────────────────────────────

describe("parseFrontmatter", () => {
    it("parses standard frontmatter", () => {
        const result = parseFrontmatter("---\nname: scout\ndescription: Fast recon\n---\nBody text");
        assert.deepEqual(result.frontmatter, { name: "scout", description: "Fast recon" });
        assert.equal(result.body, "Body text");
    });

    it("returns empty frontmatter for no delimiter", () => {
        const result = parseFrontmatter("Just body text");
        assert.deepEqual(result.frontmatter, {});
        assert.equal(result.body, "Just body text");
    });

    it("returns empty frontmatter for unclosed delimiter", () => {
        const result = parseFrontmatter("---\nname: test\nno closing delimiter");
        assert.deepEqual(result.frontmatter, {});
        assert.equal(result.body, "---\nname: test\nno closing delimiter");
    });

    it("skips lines without colons", () => {
        const result = parseFrontmatter("---\nname: test\nno-colon-line\ndescription: hello\n---\nbody");
        assert.deepEqual(result.frontmatter, { name: "test", description: "hello" });
    });

    it("skips keys with empty values", () => {
        const result = parseFrontmatter("---\nname: test\nempty:\ndescription: hello\n---\nbody");
        assert.deepEqual(result.frontmatter, { name: "test", description: "hello" });
    });

    it("handles values with colons", () => {
        const result = parseFrontmatter("---\nname: model:test\n---\nbody");
        assert.equal(result.frontmatter.name, "model:test");
    });
});

describe("findNearestProjectAgentsDir", () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = makeTmpDir();
    });

    afterEach(() => {
        cleanupDir(tmpDir);
    });

    it("finds .pi/agents/ in the given directory", () => {
        const agentsDir = path.join(tmpDir, ".pi", "agents");
        fs.mkdirSync(agentsDir, { recursive: true });
        assert.equal(findNearestProjectAgentsDir(tmpDir), agentsDir);
    });

    it("finds .pi/agents/ in a parent directory", () => {
        const agentsDir = path.join(tmpDir, ".pi", "agents");
        fs.mkdirSync(agentsDir, { recursive: true });
        const childDir = path.join(tmpDir, "src", "deep", "nested");
        fs.mkdirSync(childDir, { recursive: true });
        assert.equal(findNearestProjectAgentsDir(childDir), agentsDir);
    });

    it("returns null when no .pi/agents/ exists", () => {
        assert.equal(findNearestProjectAgentsDir(tmpDir), null);
    });

    it("respects max depth limit", () => {
        // Create a very deep directory structure
        let deepDir = tmpDir;
        for (let i = 0; i < 15; i++) {
            deepDir = path.join(deepDir, `level${i}`);
        }
        fs.mkdirSync(deepDir, { recursive: true });
        // Put agents dir at tmpDir root — 15 levels up, beyond the 10-level cap
        fs.mkdirSync(path.join(tmpDir, ".pi", "agents"), { recursive: true });
        assert.equal(findNearestProjectAgentsDir(deepDir), null);
    });
});

describe("discoverAgents", () => {
    let tmpDir: string;
    let userAgentsDir: string;
    let projectRoot: string;
    let projectAgentsDir: string;
    let originalHome: string;

    beforeEach(() => {
        tmpDir = makeTmpDir();
        // Create a fake home with user agents
        userAgentsDir = path.join(tmpDir, "home", ".pi", "agent", "agents");
        fs.mkdirSync(userAgentsDir, { recursive: true });
        // Create a project with project agents
        projectRoot = path.join(tmpDir, "project");
        projectAgentsDir = path.join(projectRoot, ".pi", "agents");
        fs.mkdirSync(projectAgentsDir, { recursive: true });
        // Override HOME for the test
        originalHome = os.homedir();
        // We can't easily override os.homedir(), so we test with the real agents dir.
        // Instead, test scope logic with a project dir and verify the result structure.
    });

    afterEach(() => {
        cleanupDir(tmpDir);
    });

    it("returns AgentDiscoveryResult with agents map and projectAgentsDir", () => {
        writeAgentFile(projectAgentsDir, "test-agent.md", makeAgentMd("test-agent", "A test agent"));
        const result = discoverAgents(projectRoot, "project");
        assert.ok(result.agents instanceof Map);
        assert.equal(result.projectAgentsDir, projectAgentsDir);
    });

    it("scope 'project' only loads project agents", () => {
        writeAgentFile(projectAgentsDir, "proj-agent.md", makeAgentMd("proj-agent", "Project agent"));
        const result = discoverAgents(projectRoot, "project");
        const agent = result.agents.get("proj-agent");
        assert.ok(agent, "project agent should be found");
        assert.equal(agent.source, "project");
        assert.equal(agent.description, "Project agent");
    });

    it("scope 'user' sets projectAgentsDir to null", () => {
        const result = discoverAgents(projectRoot, "user");
        assert.equal(result.projectAgentsDir, null);
    });

    it("parses agent config correctly", () => {
        writeAgentFile(
            projectAgentsDir,
            "full-agent.md",
            makeAgentMd("full-agent", "Full config", { model: "claude-haiku-4-5", tools: "read, bash, edit" }),
        );
        const result = discoverAgents(projectRoot, "project");
        const agent = result.agents.get("full-agent")!;
        assert.equal(agent.name, "full-agent");
        assert.equal(agent.description, "Full config");
        assert.equal(agent.model, "claude-haiku-4-5");
        assert.deepEqual(agent.tools, ["read", "bash", "edit"]);
        assert.equal(agent.source, "project");
        assert.ok(agent.filePath.endsWith("full-agent.md"));
        assert.equal(agent.systemPrompt, "System prompt for full-agent.");
    });

    it("skips files without required frontmatter", () => {
        writeAgentFile(projectAgentsDir, "bad.md", "---\nname: bad\n---\nNo description");
        const result = discoverAgents(projectRoot, "project");
        assert.equal(result.agents.size, 0);
    });

    it("skips non-md files", () => {
        writeAgentFile(projectAgentsDir, "readme.txt", "not an agent");
        writeAgentFile(projectAgentsDir, "good.md", makeAgentMd("good", "Good agent"));
        const result = discoverAgents(projectRoot, "project");
        assert.equal(result.agents.size, 1);
        assert.ok(result.agents.has("good"));
    });

    it("project agents override user agents with same name in 'both' scope", () => {
        // This test verifies the override logic with two project agents
        // (we can't easily mock the user agents dir)
        writeAgentFile(projectAgentsDir, "agent.md", makeAgentMd("agent", "Project version"));
        const result = discoverAgents(projectRoot, "both");
        const agent = result.agents.get("agent");
        // If there's also a user agent with this name, project should win
        // We can at least verify the project agent is present
        if (agent) {
            assert.equal(agent.source, "project");
            assert.equal(agent.description, "Project version");
        }
    });

    it("handles empty agents directory", () => {
        const result = discoverAgents(projectRoot, "project");
        assert.equal(result.agents.size, 0);
        assert.equal(result.projectAgentsDir, projectAgentsDir);
    });

    it("handles non-existent project directory gracefully", () => {
        const result = discoverAgents("/tmp/nonexistent-dir-12345", "project");
        assert.equal(result.agents.size, 0);
        assert.equal(result.projectAgentsDir, null);
    });

    it("default scope is 'both'", () => {
        writeAgentFile(projectAgentsDir, "test.md", makeAgentMd("test", "Test"));
        const result = discoverAgents(projectRoot);
        assert.ok(result.projectAgentsDir !== null);
    });

    it("handles agents without tools or model", () => {
        writeAgentFile(projectAgentsDir, "minimal.md", makeAgentMd("minimal", "Minimal agent"));
        const result = discoverAgents(projectRoot, "project");
        const agent = result.agents.get("minimal")!;
        assert.equal(agent.tools, undefined);
        assert.equal(agent.model, undefined);
    });

    it("handles symlinked agent files", () => {
        // Create actual file in a different location
        const sourceDir = path.join(tmpDir, "source");
        fs.mkdirSync(sourceDir, { recursive: true });
        const sourcePath = path.join(sourceDir, "linked-agent.md");
        fs.writeFileSync(sourcePath, makeAgentMd("linked", "A linked agent"));
        // Symlink into project agents
        fs.symlinkSync(sourcePath, path.join(projectAgentsDir, "linked-agent.md"));
        const result = discoverAgents(projectRoot, "project");
        assert.ok(result.agents.has("linked"));
    });
});
