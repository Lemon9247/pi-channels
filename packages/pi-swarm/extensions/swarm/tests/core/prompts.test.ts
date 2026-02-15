import { describe, it, beforeEach } from "node:test";
import * as assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
    loadPrompts,
    clearPromptCache,
    buildSystemPrompt,
    type PromptStore,
    type PromptOptions,
} from "../../core/prompts.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = path.resolve(__dirname, "../../prompts");

describe("prompt loader", () => {
    beforeEach(() => {
        clearPromptCache();
    });

    it("loads all role files", () => {
        const store = loadPrompts(PROMPTS_DIR);
        assert.ok(store.roles.has("agent"), "missing agent role");
        assert.ok(store.roles.has("coordinator"), "missing coordinator role");
        assert.equal(store.roles.size, 2);
    });

    it("loads all tool files", () => {
        const store = loadPrompts(PROMPTS_DIR);
        const expected = [
            "message", "hive-done", "hive-blocker",
            "swarm-instruct", "swarm-status",
        ];
        for (const name of expected) {
            assert.ok(store.tools.has(name), `missing tool: ${name}`);
        }
        assert.equal(store.tools.size, expected.length);
    });

    it("loads all pattern files", () => {
        const store = loadPrompts(PROMPTS_DIR);
        const expected = ["channels", "coordination", "hive-mind", "inbox-patterns"];
        for (const name of expected) {
            assert.ok(store.patterns.has(name), `missing pattern: ${name}`);
        }
        assert.equal(store.patterns.size, expected.length);
    });

    it("all files are non-empty", () => {
        const store = loadPrompts(PROMPTS_DIR);
        for (const [name, content] of store.roles) {
            assert.ok(content.trim().length > 0, `role ${name} is empty`);
        }
        for (const [name, content] of store.tools) {
            assert.ok(content.trim().length > 0, `tool ${name} is empty`);
        }
        for (const [name, content] of store.patterns) {
            assert.ok(content.trim().length > 0, `pattern ${name} is empty`);
        }
    });

    it("caches results across calls", () => {
        const store1 = loadPrompts(PROMPTS_DIR);
        const store2 = loadPrompts(PROMPTS_DIR);
        assert.equal(store1, store2, "should return same object reference");
    });

    it("clearPromptCache allows reload", () => {
        const store1 = loadPrompts(PROMPTS_DIR);
        clearPromptCache();
        const store2 = loadPrompts(PROMPTS_DIR);
        assert.notEqual(store1, store2, "should return new object after clear");
    });

    it("handles missing directory gracefully", () => {
        const store = loadPrompts("/tmp/nonexistent-prompts-dir");
        assert.equal(store.roles.size, 0);
        assert.equal(store.tools.size, 0);
        assert.equal(store.patterns.size, 0);
    });
});

describe("prompt builder", () => {
    beforeEach(() => {
        clearPromptCache();
    });

    it("builds agent prompt with template variables substituted", () => {
        const prompt = buildSystemPrompt({
            role: "agent",
            agentName: "agent a1",
            swarmAgents: ["agent a1", "agent a2", "agent a3"],
        });

        // Agent name substituted
        assert.ok(prompt.includes("agent a1"), "should contain agent name");

        // Channel list generated
        assert.ok(prompt.includes("`general`"), "should contain general channel");
        assert.ok(prompt.includes("`inbox-agent-a1`"), "should contain own inbox");
        assert.ok(prompt.includes("`inbox-queen`"), "should contain queen inbox");
        assert.ok(prompt.includes("agent a2 (`inbox-agent-a2`)"), "should list other agents");
        assert.ok(prompt.includes("agent a3 (`inbox-agent-a3`)"), "should list other agents");

        // No unsubstituted template variables
        assert.ok(!prompt.includes("{{"), "should have no unsubstituted variables");
    });

    it("builds agent prompt without coordinator sections", () => {
        const prompt = buildSystemPrompt({
            role: "agent",
            agentName: "agent a1",
            swarmAgents: ["agent a1"],
        });

        assert.ok(!prompt.includes("# Team Lead"), "agent prompt should not include team lead role");
        // Agent prompt should not include coordinator tool docs (## swarm_instruct heading)
        // but may mention swarm_instruct in pattern files (agents receive instructions)
        assert.ok(!prompt.includes("## swarm_instruct"), "agent prompt should not include swarm_instruct tool doc");
        assert.ok(!prompt.includes("## swarm_status"), "agent prompt should not include swarm_status tool doc");
    });

    it("builds coordinator prompt with team lead sections", () => {
        const prompt = buildSystemPrompt({
            role: "coordinator",
            agentName: "coord-alpha",
            swarmAgents: ["coord-alpha", "agent a1"],
        });

        // Has team lead role content
        assert.ok(prompt.includes("Team Lead"), "should include team lead role");
        assert.ok(prompt.includes("swarm_instruct"), "should include swarm_instruct tool doc");
        assert.ok(prompt.includes("swarm_status"), "should include swarm_status tool doc");

        // Still has agent base
        assert.ok(prompt.includes("coord-alpha"), "should contain agent name");
        assert.ok(prompt.includes("message"), "should include agent tool docs");
    });

    it("includes file paths when agentFiles provided", () => {
        const prompt = buildSystemPrompt({
            role: "agent",
            agentName: "agent a1",
            swarmAgents: ["agent a1"],
            agentFiles: {
                hiveMindPath: "/tmp/task/hive-mind.md",
                reportPath: "/tmp/task/agent-a1-report.md",
            },
        });

        assert.ok(prompt.includes("/tmp/task/hive-mind.md"), "should contain hive-mind path");
        assert.ok(prompt.includes("/tmp/task/agent-a1-report.md"), "should contain report path");
    });

    it("includes coordinator-specific file paths", () => {
        const prompt = buildSystemPrompt({
            role: "coordinator",
            agentName: "coord-alpha",
            swarmAgents: ["coord-alpha"],
            agentFiles: {
                hiveMindPath: "/tmp/task/hive-mind.md",
                reportPath: "/tmp/task/coord-alpha-report.md",
                crossSwarmPath: "/tmp/task/cross-swarm.md",
                synthesisPath: "/tmp/task/synthesis.md",
            },
        });

        assert.ok(prompt.includes("/tmp/task/cross-swarm.md"), "should contain cross-swarm path");
        assert.ok(prompt.includes("/tmp/task/synthesis.md"), "should contain synthesis path");
    });

    it("handles missing agentFiles gracefully", () => {
        const prompt = buildSystemPrompt({
            role: "agent",
            agentName: "agent a1",
            swarmAgents: ["agent a1"],
        });

        assert.ok(prompt.includes("No task directory"), "should mention no task dir");
    });

    it("includes all agent tool docs", () => {
        const prompt = buildSystemPrompt({
            role: "agent",
            agentName: "agent a1",
            swarmAgents: ["agent a1"],
        });

        assert.ok(prompt.includes("## message"), "should include message tool doc");
        assert.ok(prompt.includes("hive_done"), "should include hive_done doc");
        assert.ok(prompt.includes("hive_blocker"), "should include hive_blocker doc");
    });

    it("includes all pattern docs", () => {
        const prompt = buildSystemPrompt({
            role: "agent",
            agentName: "agent a1",
            swarmAgents: ["agent a1"],
        });

        // Check for content from each pattern file
        assert.ok(prompt.includes("fan messages out"), "should include channels pattern");
        assert.ok(prompt.includes("Message early"), "should include coordination pattern");
        assert.ok(prompt.includes("NEVER use the `write` tool on the notes file"), "should include notes file pattern");
        assert.ok(prompt.includes("Inbox Patterns"), "should include inbox patterns");
    });

    it("omits other agents section for single-agent swarm", () => {
        const prompt = buildSystemPrompt({
            role: "agent",
            agentName: "agent a1",
            swarmAgents: ["agent a1"],
        });

        assert.ok(!prompt.includes("Other Agents"), "single agent should not list others");
    });

    it("sections are separated by dividers", () => {
        const prompt = buildSystemPrompt({
            role: "agent",
            agentName: "agent a1",
            swarmAgents: ["agent a1"],
        });

        assert.ok(prompt.includes("---"), "sections should be separated by dividers");
    });

    it("includes topic channel in channel list when provided", () => {
        const prompt = buildSystemPrompt({
            role: "agent",
            agentName: "agent a1",
            swarmAgents: ["agent a1", "agent b1"],
            topicChannel: "topic-frontend",
        });

        assert.ok(prompt.includes("`topic-frontend`"), "should contain topic channel name");
        assert.ok(prompt.includes("Your Team"), "should label it as team channel");
        assert.ok(prompt.includes("cross-team"), "general should mention cross-team use");
    });

    it("omits topic channel when not provided", () => {
        const prompt = buildSystemPrompt({
            role: "agent",
            agentName: "agent a1",
            swarmAgents: ["agent a1"],
        });

        assert.ok(!prompt.includes("Your Team"), "should not have team channel section");
        assert.ok(!prompt.includes("topic-"), "should not reference any topic channel");
    });

    it("does not reference old concepts", () => {
        const prompt = buildSystemPrompt({
            role: "coordinator",
            agentName: "coord-alpha",
            swarmAgents: ["coord-alpha", "agent a1"],
            agentFiles: {
                hiveMindPath: "/tmp/hive-mind.md",
                reportPath: "/tmp/report.md",
                crossSwarmPath: "/tmp/cross-swarm.md",
                synthesisPath: "/tmp/synthesis.md",
            },
        });

        assert.ok(!prompt.includes("typed message"), "should not reference typed messages");
        assert.ok(!prompt.includes("subject routing"), "should not reference subject routing");
        assert.ok(!prompt.includes("single socket"), "should not reference single socket");
    });
});
