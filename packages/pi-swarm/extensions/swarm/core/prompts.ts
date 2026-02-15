/**
 * Prompt Loader & Builder
 *
 * Loads prompt templates from markdown files and assembles them
 * into system prompts for swarm agents and coordinators.
 *
 * Directory structure:
 *   prompts/
 *   ├── roles/        agent.md, coordinator.md
 *   ├── tools/        message.md, hive-done.md, etc.
 *   └── patterns/     channels.md, coordination.md, etc.
 *
 * Template variables:
 *   {{agentName}}        — agent display name
 *   {{channels}}         — generated channel list
 *   {{files}}            — generated file paths section
 *   {{coordinatorFiles}} — cross-swarm + synthesis paths (coordinator only)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentFiles } from "./scaffold.js";
import { inboxName, GENERAL_CHANNEL, QUEEN_INBOX } from "./channels.js";

// ─── Types ───────────────────────────────────────────────────────────

export interface PromptStore {
    roles: Map<string, string>;
    tools: Map<string, string>;
    patterns: Map<string, string>;
}

export interface PromptOptions {
    role: "agent" | "coordinator";
    agentName: string;
    swarmAgents: string[];       // all agent names in the swarm
    agentFiles?: AgentFiles;
    topicChannel?: string;       // topic channel name (multi-team swarms only)
}

// ─── Prompt Loading ──────────────────────────────────────────────────

const PROMPTS_DIR = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "prompts",
);

const _cache = new Map<string, PromptStore>();

/**
 * Load all .md files from a directory into a Map<name, content>.
 * Keys are filenames without extension. Files are sorted alphabetically
 * for deterministic ordering across filesystems.
 */
function loadDir(dirPath: string): Map<string, string> {
    const result = new Map<string, string>();
    if (!fs.existsSync(dirPath)) return result;
    const files = fs.readdirSync(dirPath).filter((f) => f.endsWith(".md")).sort();
    for (const file of files) {
        const name = file.slice(0, -3); // strip .md
        const content = fs.readFileSync(path.join(dirPath, file), "utf-8");
        result.set(name, content);
    }
    return result;
}

/**
 * Load all prompt files from the prompts/ directory.
 * Results are cached per resolved directory path.
 */
export function loadPrompts(promptsDir?: string): PromptStore {
    const dir = path.resolve(promptsDir ?? PROMPTS_DIR);
    const cached = _cache.get(dir);
    if (cached) return cached;
    const store: PromptStore = {
        roles: loadDir(path.join(dir, "roles")),
        tools: loadDir(path.join(dir, "tools")),
        patterns: loadDir(path.join(dir, "patterns")),
    };
    _cache.set(dir, store);
    return store;
}

/** Clear the cached prompt store (for testing). */
export function clearPromptCache(): void {
    _cache.clear();
}

// ─── Channel List Generation ─────────────────────────────────────────

/**
 * Generate the "Your Channels" section for an agent's prompt.
 */
function generateChannelList(agentName: string, swarmAgents: string[], topicChannel?: string): string {
    const myInbox = inboxName(agentName);
    const others = swarmAgents
        .filter((n) => n !== agentName)
        .map((n) => `${n} (\`${inboxName(n)}\`)`)
        .join(", ");

    const lines = [
        "## Your Channels\n",
    ];

    if (topicChannel) {
        lines.push(`- **Your Team** (\`${topicChannel}\`): Your sub-team's channel. Prefer this for findings and coordination within your team.`);
    }
    lines.push(`- **General** (\`${GENERAL_CHANNEL}\`): Broadcast — all agents and the queen read this.${topicChannel ? " Use for cross-team announcements." : ""}`);
    lines.push(`- **Your Inbox** (\`${myInbox}\`): Only you read this. The queen and other agents can write here.`);
    lines.push(`- **Queen Inbox** (\`${QUEEN_INBOX}\`): Send completion signals and blockers here.`);

    if (others) {
        lines.push(`- **Other Agents**: ${others}`);
    }

    return lines.join("\n");
}

// ─── File Paths Section ──────────────────────────────────────────────

/**
 * Generate the "Your Files" section for an agent's prompt.
 */
function generateFileSection(agentFiles?: AgentFiles): string {
    if (!agentFiles) {
        return "## Your Files\n\nNo task directory was specified for this swarm.";
    }

    const lines = [
        "## Your Files\n",
        `- **Hive-mind**: \`${agentFiles.hiveMindPath}\``,
        `- **Your report**: \`${agentFiles.reportPath}\``,
    ];

    if (agentFiles.crossSwarmPath) {
        lines.push(`- **Cross-swarm findings**: \`${agentFiles.crossSwarmPath}\``);
    }
    if (agentFiles.synthesisPath) {
        lines.push(`- **Synthesis**: \`${agentFiles.synthesisPath}\``);
    }

    return lines.join("\n");
}

/**
 * Generate coordinator-specific file paths section.
 */
function generateCoordinatorFiles(agentFiles?: AgentFiles): string {
    const lines: string[] = [];
    if (agentFiles?.crossSwarmPath) {
        lines.push(`**Cross-swarm findings**: Write discoveries that affect other swarms to: \`${agentFiles.crossSwarmPath}\``);
    }
    if (agentFiles?.synthesisPath) {
        lines.push(`**Synthesis**: After all your agents complete, write a synthesis of their reports to: \`${agentFiles.synthesisPath}\``);
    }
    return lines.join("\n\n");
}

// ─── Template Substitution ───────────────────────────────────────────

/**
 * Replace all {{variable}} placeholders in a template string.
 */
function substitute(template: string, vars: Record<string, string>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
        return vars[key] ?? "";
    });
}

// ─── Prompt Builder ──────────────────────────────────────────────────

/** Tool doc names for each role. */
const AGENT_TOOLS = ["message", "hive-done", "hive-blocker"];
const COORDINATOR_TOOLS = [...AGENT_TOOLS, "swarm-instruct", "swarm-status"];

/**
 * Build a complete system prompt for a swarm agent or coordinator.
 *
 * Assembly order:
 * 1. Role template (agent.md, always)
 * 2. Coordinator template (coordinator.md, if coordinator)
 * 3. Tool documentation (based on role)
 * 4. Pattern files (all, always)
 *
 * Template variables are substituted in each section.
 */
export function buildSystemPrompt(options: PromptOptions): string {
    const store = loadPrompts();
    const { role, agentName, swarmAgents, agentFiles, topicChannel } = options;

    const vars: Record<string, string> = {
        agentName,
        channels: generateChannelList(agentName, swarmAgents, topicChannel),
        files: generateFileSection(agentFiles),
        coordinatorFiles: generateCoordinatorFiles(agentFiles),
    };

    const sections: string[] = [];

    // 1. Agent role (always)
    const agentRole = store.roles.get("agent");
    if (agentRole) {
        sections.push(substitute(agentRole, vars));
    }

    // 2. Coordinator role (if applicable)
    if (role === "coordinator") {
        const coordRole = store.roles.get("coordinator");
        if (coordRole) {
            sections.push(substitute(coordRole, vars));
        }
    }

    // 3. Tool documentation
    const toolNames = role === "coordinator" ? COORDINATOR_TOOLS : AGENT_TOOLS;
    const toolSections: string[] = [];
    for (const toolName of toolNames) {
        const doc = store.tools.get(toolName);
        if (doc) {
            toolSections.push(substitute(doc, vars));
        }
    }
    if (toolSections.length > 0) {
        sections.push("# Tool Reference\n\n" + toolSections.join("\n\n"));
    }

    // 4. Pattern files
    const patternSections: string[] = [];
    for (const [_name, content] of store.patterns) {
        patternSections.push(substitute(content, vars));
    }
    if (patternSections.length > 0) {
        sections.push("# Coordination Patterns\n\n" + patternSections.join("\n\n"));
    }

    return sections.join("\n\n---\n\n");
}
