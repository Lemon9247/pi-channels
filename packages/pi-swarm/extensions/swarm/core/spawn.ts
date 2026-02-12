/**
 * Agent Spawning
 *
 * Handles spawning pi agent processes with correct environment variables,
 * system prompts, and process configuration.
 *
 * Agents are spawned as detached background processes with channel
 * coordination (spawnAgent). Arg-building logic is in buildAgentArgs().
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildSystemPrompt } from "./prompts.js";
import { type AgentConfig } from "./agents.js";
import type { AgentFiles } from "./scaffold.js";
import { ENV, inboxName, GENERAL_CHANNEL } from "./channels.js";

// ─── Types ───────────────────────────────────────────────────────────

/** Base agent definition. */
export interface AgentDef {
    name: string;
    task: string;
    agent?: string;
    systemPrompt?: string;
    tools?: string[];
    model?: string;
    cwd?: string;
}

/** Swarm-specific agent definition — adds role and swarm assignment. */
export interface SwarmAgentDef extends AgentDef {
    role: "agent" | "coordinator";
    swarm: string;
}

// ─── Shared Arg Building ─────────────────────────────────────────────

export function writePromptToTempFile(name: string, prompt: string): { dir: string; filePath: string } {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-swarm-"));
    const safeName = name.replace(/[^\w.-]+/g, "_");
    const filePath = path.join(tmpDir, `swarm-prompt-${safeName}.md`);
    fs.writeFileSync(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
    return { dir: tmpDir, filePath };
}

interface ResolvedAgent {
    /** CLI args for pi (--mode, --model, --tools, --append-system-prompt, task). */
    args: string[];
    /** Temp dir for the prompt file (caller must clean up). */
    tmpDir: string;
    /** Path to the temp prompt file. */
    tmpPromptPath: string;
    /** Resolved model (from inline def > agent file > undefined). */
    model?: string;
    /** Resolved agent source. */
    source: "user" | "project" | "unknown";
}

/**
 * Build CLI args for a pi agent process.
 *
 * Handles model resolution (inline > agent file > default), tool flags,
 * system prompt assembly, and temp file management.
 *
 * Used by both detached and blocking spawn modes. The caller is responsible
 * for cleaning up tmpDir/tmpPromptPath on process exit.
 *
 * @param agentDef Agent definition (inline or pre-defined)
 * @param knownAgents Map of discovered agents (for pre-defined agent lookup)
 * @param promptSuffix Optional additional prompt content to append (e.g. swarm coordination)
 */
export function buildAgentArgs(
    agentDef: AgentDef,
    knownAgents?: Map<string, AgentConfig>,
    promptSuffix?: string,
): ResolvedAgent {
    // Clone to avoid mutating caller's params
    agentDef = { ...agentDef };

    let source: "user" | "project" | "unknown" = "unknown";

    // Pre-defined agent — merge config defaults
    if (agentDef.agent && knownAgents) {
        const agentConfig = knownAgents.get(agentDef.agent);
        if (agentConfig) {
            if (!agentDef.systemPrompt && agentConfig.systemPrompt) {
                agentDef.systemPrompt = agentConfig.systemPrompt;
            }
            if (!agentDef.tools && agentConfig.tools) {
                agentDef.tools = agentConfig.tools;
            }
            if (!agentDef.model && agentConfig.model) {
                agentDef.model = agentConfig.model;
            }
            source = agentConfig.source;
        }
    }

    const args: string[] = ["--mode", "json", "-p", "--no-session"];

    // Model (after merge so pre-defined agent model is available)
    if (agentDef.model) {
        args.push("--model", agentDef.model);
    }

    // Tools
    if (agentDef.tools && agentDef.tools.length > 0) {
        args.push("--tools", agentDef.tools.join(","));
    }

    // System prompt
    let systemPrompt = "";
    if (agentDef.systemPrompt) {
        systemPrompt = agentDef.systemPrompt + "\n\n";
    }
    if (promptSuffix) {
        systemPrompt += promptSuffix;
    }

    const { dir: tmpDir, filePath: tmpPromptPath } = writePromptToTempFile(agentDef.name, systemPrompt);
    args.push("--append-system-prompt", tmpPromptPath);

    // Task as the prompt
    args.push(`Task: ${agentDef.task}`);

    return {
        args,
        tmpDir,
        tmpPromptPath,
        model: agentDef.model,
        source,
    };
}

function cleanupTempFiles(tmpPromptPath: string, tmpDir: string): void {
    try { fs.unlinkSync(tmpPromptPath); } catch { /* ignore */ }
    try { fs.rmdirSync(tmpDir); } catch { /* ignore */ }
}

// ─── Detached Spawn (Swarm) ──────────────────────────────────────────

/**
 * Spawn an agent as a detached background process with channel coordination.
 *
 * Used by the swarm tool. The process runs in its own process group and
 * receives channel configuration via environment variables.
 */
export function spawnAgent(
    agentDef: SwarmAgentDef,
    channelGroupPath: string,
    taskDirPath: string | undefined,
    defaultCwd: string,
    knownAgents?: Map<string, AgentConfig>,
    agentFiles?: AgentFiles,
    swarmAgentNames?: string[],
    topicChannel?: string,
): { process: ChildProcess; tmpDir?: string } {
    // Build swarm coordination prompt
    const coordinationPrompt = buildSystemPrompt({
        role: agentDef.role,
        agentName: agentDef.name,
        swarmAgents: swarmAgentNames ?? [agentDef.name],
        agentFiles,
        topicChannel,
    });

    const resolved = buildAgentArgs(agentDef, knownAgents, coordinationPrompt);

    // Environment variables for channel connection
    const inbox = inboxName(agentDef.name);
    const subscribeChannels = [GENERAL_CHANNEL];
    if (topicChannel) {
        subscribeChannels.push(topicChannel);
    }
    const env: Record<string, string | undefined> = {
        ...process.env,
        [ENV.GROUP]: channelGroupPath,
        [ENV.INBOX]: inbox,
        [ENV.SUBSCRIBE]: subscribeChannels.join(","),
        [ENV.NAME]: agentDef.name,
        [ENV.TOPIC]: topicChannel ?? "",
        PI_SWARM_AGENT_NAME: agentDef.name,
        PI_SWARM_AGENT_ROLE: agentDef.role,
        PI_SWARM_AGENT_SWARM: agentDef.swarm,
    };

    // Pass task dir to coordinators
    if (taskDirPath && agentDef.role === "coordinator") {
        env.PI_SWARM_TASK_DIR = taskDirPath;
    }

    const proc = spawn("pi", resolved.args, {
        cwd: agentDef.cwd || defaultCwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
        env,
    });

    // Clean up temp files when process exits
    proc.on("close", () => {
        cleanupTempFiles(resolved.tmpPromptPath, resolved.tmpDir);
    });

    return { process: proc, tmpDir: resolved.tmpDir };
}


