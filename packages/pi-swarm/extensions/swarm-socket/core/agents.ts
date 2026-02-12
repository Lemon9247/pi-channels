/**
 * Agent Discovery
 *
 * Discovers agent definitions from ~/.pi/agent/agents/ (user) and
 * .pi/agents/ (project-local). Supports scope control for filtering
 * by source. Project agents override user agents of the same name.
 *
 * Ported from the subagent extension with scope-aware API.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ─── Types ───────────────────────────────────────────────────────────

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
    name: string;
    description: string;
    tools?: string[];
    model?: string;
    systemPrompt: string;
    source: "user" | "project";
    filePath: string;
}

export interface AgentDiscoveryResult {
    agents: Map<string, AgentConfig>;
    projectAgentsDir: string | null;
}

// ─── Frontmatter Parser ─────────────────────────────────────────────

/**
 * Parse simple YAML frontmatter from markdown.
 * Returns { frontmatter, body } where frontmatter is key-value pairs.
 *
 * Handles simple `key: value` pairs. Tools are expected as a
 * comma-separated list on a single line (e.g. `tools: read, bash, edit`).
 */
export function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
    if (!content.startsWith("---")) {
        return { frontmatter: {}, body: content };
    }

    const endIdx = content.indexOf("\n---", 3);
    if (endIdx === -1) {
        return { frontmatter: {}, body: content };
    }

    const yamlBlock = content.slice(4, endIdx);
    const body = content.slice(endIdx + 4).trim();

    const frontmatter: Record<string, string> = {};
    for (const line of yamlBlock.split("\n")) {
        const colonIdx = line.indexOf(":");
        if (colonIdx === -1) continue;
        const key = line.slice(0, colonIdx).trim();
        const value = line.slice(colonIdx + 1).trim();
        if (key && value) {
            frontmatter[key] = value;
        }
    }

    return { frontmatter, body };
}

// ─── Directory Loading ───────────────────────────────────────────────

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
    const agents: AgentConfig[] = [];

    if (!fs.existsSync(dir)) return agents;

    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return agents;
    }

    for (const entry of entries) {
        if (!entry.name.endsWith(".md")) continue;
        if (!entry.isFile() && !entry.isSymbolicLink()) continue;

        const filePath = path.join(dir, entry.name);
        let content: string;
        try {
            content = fs.readFileSync(filePath, "utf-8");
        } catch {
            continue;
        }

        const { frontmatter, body } = parseFrontmatter(content);

        if (!frontmatter.name || !frontmatter.description) continue;

        const tools = frontmatter.tools
            ?.split(",")
            .map((t: string) => t.trim())
            .filter(Boolean);

        agents.push({
            name: frontmatter.name,
            description: frontmatter.description,
            tools: tools && tools.length > 0 ? tools : undefined,
            model: frontmatter.model,
            systemPrompt: body,
            source,
            filePath,
        });
    }

    return agents;
}

// ─── Project Agent Resolution ────────────────────────────────────────

/**
 * Walk up from cwd to find the nearest .pi/agents/ directory.
 * Returns null if none found. Capped at 10 levels to avoid
 * traversing the entire filesystem.
 */
export function findNearestProjectAgentsDir(cwd: string): string | null {
    const MAX_DEPTH = 10;
    let currentDir = cwd;
    let depth = 0;

    while (depth < MAX_DEPTH) {
        const candidate = path.join(currentDir, ".pi", "agents");
        try {
            if (fs.statSync(candidate).isDirectory()) return candidate;
        } catch { /* doesn't exist, keep walking */ }

        const parent = path.dirname(currentDir);
        if (parent === currentDir) return null; // filesystem root
        currentDir = parent;
        depth++;
    }

    return null;
}

// ─── Discovery ───────────────────────────────────────────────────────

/**
 * Discover agents from user and/or project directories.
 *
 * Scope controls which sources are included:
 * - "user": only ~/.pi/agent/agents/
 * - "project": only .pi/agents/ (walked up from cwd)
 * - "both": user + project (project overrides user on name collision)
 *
 * Returns a Map keyed by agent name, plus the resolved project agents dir.
 */
export function discoverAgents(cwd: string, scope: AgentScope = "both"): AgentDiscoveryResult {
    const userDir = path.join(os.homedir(), ".pi", "agent", "agents");
    const projectAgentsDir = scope === "user" ? null : findNearestProjectAgentsDir(cwd);

    const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
    const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

    const agents = new Map<string, AgentConfig>();

    // User agents go in first
    if (scope !== "project") {
        for (const agent of userAgents) agents.set(agent.name, agent);
    }

    // Project agents override user agents on name collision
    if (scope !== "user") {
        for (const agent of projectAgents) agents.set(agent.name, agent);
    }

    return { agents, projectAgentsDir };
}
