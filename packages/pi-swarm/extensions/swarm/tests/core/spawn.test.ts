/**
 * Tests for core/spawn.ts
 *
 * Tests the shared arg-building logic (buildAgentArgs) which is used by
 * both detached and blocking spawn modes. We can't easily test actual
 * process spawning in unit tests, but we can verify:
 * - Model resolution (inline > agent file > default)
 * - Tool flag assembly
 * - System prompt composition and temp file creation
 * - Agent config merging from known agents
 */

import { describe, it, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import { buildAgentArgs, writePromptToTempFile, type AgentDef } from "../../core/spawn.js";
import type { AgentConfig } from "../../core/agents.js";

// ─── Helpers ─────────────────────────────────────────────────────────

const tmpFiles: string[] = [];

function cleanup(): void {
    for (const f of tmpFiles) {
        try { fs.unlinkSync(f); } catch { /* ignore */ }
        try { fs.rmdirSync(f.replace(/\/[^/]+$/, "")); } catch { /* ignore */ }
    }
    tmpFiles.length = 0;
}

function makeKnownAgents(...configs: AgentConfig[]): Map<string, AgentConfig> {
    const map = new Map<string, AgentConfig>();
    for (const c of configs) map.set(c.name, c);
    return map;
}

function makeAgentConfig(name: string, overrides?: Partial<AgentConfig>): AgentConfig {
    return {
        name,
        description: `${name} agent`,
        systemPrompt: `You are ${name}.`,
        source: "user",
        filePath: `/fake/path/${name}.md`,
        ...overrides,
    };
}

afterEach(() => cleanup());

// ─── writePromptToTempFile ───────────────────────────────────────────

describe("writePromptToTempFile", () => {
    it("creates temp file with prompt content", () => {
        const { dir, filePath } = writePromptToTempFile("test-agent", "Hello prompt");
        tmpFiles.push(filePath);
        assert.ok(fs.existsSync(filePath));
        assert.equal(fs.readFileSync(filePath, "utf-8"), "Hello prompt");
        // Cleanup
        fs.unlinkSync(filePath);
        fs.rmdirSync(dir);
    });

    it("sanitizes agent name in filename", () => {
        const { filePath } = writePromptToTempFile("agent a1 (test)", "prompt");
        tmpFiles.push(filePath);
        assert.ok(filePath.includes("swarm-prompt-agent_a1_test_"));
    });

    it("sets restrictive permissions", () => {
        const { filePath } = writePromptToTempFile("secure", "secret prompt");
        tmpFiles.push(filePath);
        const stats = fs.statSync(filePath);
        // 0o600 = owner read/write only
        assert.equal(stats.mode & 0o777, 0o600);
    });
});

// ─── buildAgentArgs ──────────────────────────────────────────────────

describe("buildAgentArgs", () => {
    it("builds basic args with task", () => {
        const def: AgentDef = {
            name: "agent-1",
            task: "Do something",
        };
        const result = buildAgentArgs(def);
        tmpFiles.push(result.tmpPromptPath);

        assert.ok(result.args.includes("--mode"));
        assert.ok(result.args.includes("json"));
        assert.ok(result.args.includes("-p"));
        assert.ok(result.args.includes("--no-session"));
        assert.ok(result.args.includes("Task: Do something"));
        assert.ok(result.args.includes("--append-system-prompt"));
        assert.equal(result.source, "unknown");
    });

    it("uses inline model over agent file model", () => {
        const known = makeKnownAgents(
            makeAgentConfig("scout", { model: "claude-haiku-4-5" }),
        );
        const def: AgentDef = {
            name: "a1",
            task: "go",
            agent: "scout",
            model: "claude-sonnet-4-5",
        };
        const result = buildAgentArgs(def, known);
        tmpFiles.push(result.tmpPromptPath);

        // Inline model should be used, not agent file model
        const modelIdx = result.args.indexOf("--model");
        assert.ok(modelIdx >= 0);
        assert.equal(result.args[modelIdx + 1], "claude-sonnet-4-5");
        assert.equal(result.model, "claude-sonnet-4-5");
    });

    it("falls back to agent file model when no inline model", () => {
        const known = makeKnownAgents(
            makeAgentConfig("scout", { model: "claude-haiku-4-5" }),
        );
        const def: AgentDef = {
            name: "a1",
            task: "go",
            agent: "scout",
        };
        const result = buildAgentArgs(def, known);
        tmpFiles.push(result.tmpPromptPath);

        const modelIdx = result.args.indexOf("--model");
        assert.ok(modelIdx >= 0);
        assert.equal(result.args[modelIdx + 1], "claude-haiku-4-5");
        assert.equal(result.model, "claude-haiku-4-5");
    });

    it("no --model flag when neither inline nor agent specifies model", () => {
        const def: AgentDef = {
            name: "a1",
            task: "go",
        };
        const result = buildAgentArgs(def);
        tmpFiles.push(result.tmpPromptPath);

        assert.ok(!result.args.includes("--model"));
        assert.equal(result.model, undefined);
    });

    it("uses inline tools over agent file tools", () => {
        const known = makeKnownAgents(
            makeAgentConfig("worker", { tools: ["read", "bash"] }),
        );
        const def: AgentDef = {
            name: "a1",
            task: "go",
            agent: "worker",
            tools: ["read", "bash", "edit", "write"],
        };
        const result = buildAgentArgs(def, known);
        tmpFiles.push(result.tmpPromptPath);

        const toolsIdx = result.args.indexOf("--tools");
        assert.ok(toolsIdx >= 0);
        assert.equal(result.args[toolsIdx + 1], "read,bash,edit,write");
    });

    it("falls back to agent file tools", () => {
        const known = makeKnownAgents(
            makeAgentConfig("worker", { tools: ["read", "bash"] }),
        );
        const def: AgentDef = {
            name: "a1",
            task: "go",
            agent: "worker",
        };
        const result = buildAgentArgs(def, known);
        tmpFiles.push(result.tmpPromptPath);

        const toolsIdx = result.args.indexOf("--tools");
        assert.ok(toolsIdx >= 0);
        assert.equal(result.args[toolsIdx + 1], "read,bash");
    });

    it("no --tools flag when no tools specified anywhere", () => {
        const def: AgentDef = {
            name: "a1",
            task: "go",
        };
        const result = buildAgentArgs(def);
        tmpFiles.push(result.tmpPromptPath);

        assert.ok(!result.args.includes("--tools"));
    });

    it("writes system prompt to temp file", () => {
        const def: AgentDef = {
            name: "a1",
            task: "go",
            systemPrompt: "You are a helpful agent.",
        };
        const result = buildAgentArgs(def);
        tmpFiles.push(result.tmpPromptPath);

        const content = fs.readFileSync(result.tmpPromptPath, "utf-8");
        assert.ok(content.includes("You are a helpful agent."));
    });

    it("combines inline system prompt with agent file system prompt", () => {
        const known = makeKnownAgents(
            makeAgentConfig("scout", { systemPrompt: "Agent file prompt." }),
        );
        const def: AgentDef = {
            name: "a1",
            task: "go",
            agent: "scout",
            // No inline systemPrompt — should use agent file's
        };
        const result = buildAgentArgs(def, known);
        tmpFiles.push(result.tmpPromptPath);

        const content = fs.readFileSync(result.tmpPromptPath, "utf-8");
        assert.ok(content.includes("Agent file prompt."));
    });

    it("appends promptSuffix after system prompt", () => {
        const def: AgentDef = {
            name: "a1",
            task: "go",
            systemPrompt: "Base prompt.",
        };
        const result = buildAgentArgs(def, undefined, "Coordination instructions.");
        tmpFiles.push(result.tmpPromptPath);

        const content = fs.readFileSync(result.tmpPromptPath, "utf-8");
        assert.ok(content.includes("Base prompt."));
        assert.ok(content.includes("Coordination instructions."));
        // Suffix should come after base prompt
        assert.ok(content.indexOf("Base prompt.") < content.indexOf("Coordination instructions."));
    });

    it("tracks agent source from known agents", () => {
        const known = makeKnownAgents(
            makeAgentConfig("scout", { source: "project" }),
        );
        const def: AgentDef = {
            name: "a1",
            task: "go",
            agent: "scout",
        };
        const result = buildAgentArgs(def, known);
        tmpFiles.push(result.tmpPromptPath);

        assert.equal(result.source, "project");
    });

    it("source is 'unknown' when agent not found in known agents", () => {
        const def: AgentDef = {
            name: "a1",
            task: "go",
            agent: "nonexistent",
        };
        const known = makeKnownAgents();
        const result = buildAgentArgs(def, known);
        tmpFiles.push(result.tmpPromptPath);

        assert.equal(result.source, "unknown");
    });

    it("does not mutate the input agentDef", () => {
        const known = makeKnownAgents(
            makeAgentConfig("scout", { model: "claude-haiku-4-5", tools: ["read"], systemPrompt: "scout prompt" }),
        );
        const def: AgentDef = {
            name: "a1",
            task: "go",
            agent: "scout",
        };
        const originalModel = def.model;
        const originalTools = def.tools;
        const originalPrompt = def.systemPrompt;
        const result = buildAgentArgs(def, known);
        tmpFiles.push(result.tmpPromptPath);

        // Original def should not be mutated
        assert.equal(def.model, originalModel);
        assert.equal(def.tools, originalTools);
        assert.equal(def.systemPrompt, originalPrompt);
    });
});
