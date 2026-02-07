/**
 * Agent discovery for swarm-socket extension.
 *
 * Re-exports the agent discovery logic from the subagent extension.
 * Agents are .md files in ~/.pi/agent/agents/ with frontmatter
 * specifying name, description, tools, and model.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface AgentConfig {
    name: string;
    description: string;
    tools?: string[];
    model?: string;
    systemPrompt: string;
    filePath: string;
}

/**
 * Parse simple YAML frontmatter from markdown.
 * Returns { frontmatter, body } where frontmatter is key-value pairs.
 *
 * LIMITATION: This is a minimal parser that only handles simple `key: value` pairs.
 * It does NOT handle: quoted values (quotes become part of the value), multi-line
 * values, YAML lists (e.g. `- item`), nested objects, or other YAML features.
 * Tools are expected as a comma-separated list on a single line (e.g. `tools: read, bash, edit`).
 */
function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
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

/**
 * Discover agents from ~/.pi/agent/agents/ directory.
 * Returns a map of agent name → config.
 */
export function discoverAgents(cwd: string): Map<string, AgentConfig> {
    const agentDir = path.join(os.homedir(), ".pi", "agent", "agents");
    const agents = new Map<string, AgentConfig>();

    if (!fs.existsSync(agentDir)) return agents;

    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(agentDir, { withFileTypes: true });
    } catch {
        return agents;
    }

    for (const entry of entries) {
        if (!entry.name.endsWith(".md")) continue;
        if (!entry.isFile()) continue;

        const filePath = path.join(agentDir, entry.name);
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

        agents.set(frontmatter.name, {
            name: frontmatter.name,
            description: frontmatter.description,
            tools: tools && tools.length > 0 ? tools : undefined,
            model: frontmatter.model,
            systemPrompt: body,
            filePath,
        });
    }

    // Also check project-level .pi/agents/
    // Walk up from cwd looking for .pi/agents/, capped at 10 levels to avoid
    // traversing the entire filesystem when no project-level agents exist.
    const MAX_WALK_DEPTH = 10;
    let projectDir = cwd;
    let depth = 0;
    while (depth < MAX_WALK_DEPTH) {
        const candidate = path.join(projectDir, ".pi", "agents");
        if (fs.existsSync(candidate)) {
            try {
                const entries = fs.readdirSync(candidate, { withFileTypes: true });
                for (const entry of entries) {
                    if (!entry.name.endsWith(".md") || !entry.isFile()) continue;
                    const filePath = path.join(candidate, entry.name);
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
                    // Project agents override user agents
                    agents.set(frontmatter.name, {
                        name: frontmatter.name,
                        description: frontmatter.description,
                        tools: tools && tools.length > 0 ? tools : undefined,
                        model: frontmatter.model,
                        systemPrompt: body,
                        filePath,
                    });
                }
            } catch { /* ignore */ }
            break;
        }
        const parent = path.dirname(projectDir);
        if (parent === projectDir) break; // filesystem root
        projectDir = parent;
        depth++;
    }

    return agents;
}
