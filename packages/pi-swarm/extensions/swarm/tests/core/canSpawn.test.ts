import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { resolveCanSpawn, type AgentConfig } from "../../core/agents.js";

function createTmpAgent(name: string, frontmatter: string): { config: AgentConfig; cleanup: () => void } {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "canspawn-test-"));
    const filePath = path.join(tmpDir, `${name}.md`);
    fs.writeFileSync(filePath, frontmatter, "utf-8");

    const config: AgentConfig = {
        name,
        description: "test agent",
        systemPrompt: "test",
        source: "user",
        filePath,
    };

    return {
        config,
        cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
    };
}

describe("resolveCanSpawn", () => {
    it("returns inline canSpawn=true when set", () => {
        assert.equal(resolveCanSpawn(true, undefined, undefined), true);
    });

    it("returns inline canSpawn=false when set", () => {
        assert.equal(resolveCanSpawn(false, undefined, undefined), false);
    });

    it("defaults to false when nothing is set", () => {
        assert.equal(resolveCanSpawn(undefined, undefined, undefined), false);
    });

    it("reads canSpawn from archetype frontmatter", () => {
        const { config, cleanup } = createTmpAgent("spawner", [
            "---",
            "name: spawner",
            "description: test agent",
            "canSpawn: true",
            "---",
            "System prompt body",
        ].join("\n"));

        try {
            const agents = new Map([["spawner", config]]);
            assert.equal(resolveCanSpawn(undefined, "spawner", agents), true);
        } finally {
            cleanup();
        }
    });

    it("inline overrides archetype frontmatter", () => {
        const { config, cleanup } = createTmpAgent("spawner", [
            "---",
            "name: spawner",
            "description: test agent",
            "canSpawn: true",
            "---",
            "System prompt body",
        ].join("\n"));

        try {
            const agents = new Map([["spawner", config]]);
            // Inline false overrides archetype's true
            assert.equal(resolveCanSpawn(false, "spawner", agents), false);
        } finally {
            cleanup();
        }
    });

    it("defaults to false when archetype has no canSpawn", () => {
        const { config, cleanup } = createTmpAgent("basic", [
            "---",
            "name: basic",
            "description: basic agent",
            "---",
            "System prompt body",
        ].join("\n"));

        try {
            const agents = new Map([["basic", config]]);
            assert.equal(resolveCanSpawn(undefined, "basic", agents), false);
        } finally {
            cleanup();
        }
    });

    it("defaults to false when archetype not found in knownAgents", () => {
        const agents = new Map<string, AgentConfig>();
        assert.equal(resolveCanSpawn(undefined, "nonexistent", agents), false);
    });
});
