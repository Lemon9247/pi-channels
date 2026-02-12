/**
 * Agent Spawning
 *
 * Handles spawning pi agent processes with correct environment variables,
 * system prompts, and process configuration.
 *
 * Two spawn modes:
 * - **Detached** (spawnAgent): background process with channel coordination,
 *   returns immediately. Used by the swarm tool.
 * - **Blocking** (spawnAgentBlocking): foreground process, reads JSON stdout
 *   line by line, returns structured result on exit. Used by the subagent tool.
 *
 * Both modes share arg-building logic via buildAgentArgs().
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import { buildSystemPrompt } from "./prompts.js";
import { type AgentConfig } from "./agents.js";
import type { AgentFiles } from "./scaffold.js";
import { ENV, inboxName, GENERAL_CHANNEL } from "./channels.js";
import type { UsageStats } from "../ui/format.js";

// ─── Types ───────────────────────────────────────────────────────────

export interface SingleResult {
    agent: string;
    agentSource: "user" | "project" | "unknown";
    task: string;
    exitCode: number;
    messages: Message[];
    stderr: string;
    usage: UsageStats;
    model?: string;
    stopReason?: string;
    errorMessage?: string;
    step?: number;
}

/** Base agent definition — used by both blocking and detached spawn. */
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

/** Callback for streaming updates during blocking spawn. */
export type OnBlockingUpdate = (result: SingleResult) => void;

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

// ─── Blocking Spawn (Subagent) ───────────────────────────────────────

function emptyUsage(): UsageStats {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

/**
 * Spawn an agent as a foreground blocking process.
 *
 * Reads JSON stdout line by line as it arrives, accumulating messages
 * and usage stats. The returned Promise resolves when the process exits.
 *
 * Does NOT set channel env vars or append coordination prompts — this is
 * for isolated single-agent execution (subagent tool).
 *
 * @param agentDef Agent definition
 * @param defaultCwd Working directory if not specified in agentDef
 * @param knownAgents Map of discovered agents
 * @param signal Optional AbortSignal for cancellation
 * @param onUpdate Optional callback fired after each message_end event
 * @param step Optional step number (for chain mode tracking)
 * @param onRawLine Optional callback fired for each raw JSON stdout line (for activity tracking)
 */
export async function spawnAgentBlocking(
    agentDef: AgentDef,
    defaultCwd: string,
    knownAgents?: Map<string, AgentConfig>,
    signal?: AbortSignal,
    onUpdate?: OnBlockingUpdate,
    step?: number,
    onRawLine?: (line: string) => void,
): Promise<SingleResult> {
    const resolved = buildAgentArgs(agentDef, knownAgents);

    const result: SingleResult = {
        agent: agentDef.agent || agentDef.name,
        agentSource: resolved.source,
        task: agentDef.task,
        exitCode: 0,
        messages: [],
        stderr: "",
        usage: emptyUsage(),
        model: resolved.model,
        step,
    };

    try {
        let wasAborted = false;

        const exitCode = await new Promise<number>((resolve) => {
            const proc = spawn("pi", resolved.args, {
                cwd: agentDef.cwd || defaultCwd,
                shell: false,
                stdio: ["ignore", "pipe", "pipe"],
                // NOT detached — foreground process
            });

            let buffer = "";

            const processLine = (line: string) => {
                if (!line.trim()) return;
                onRawLine?.(line);
                let event: any;
                try {
                    event = JSON.parse(line);
                } catch {
                    return;
                }

                if (event.type === "message_end" && event.message) {
                    const msg = event.message as Message;
                    result.messages.push(msg);

                    if (msg.role === "assistant") {
                        result.usage.turns = (result.usage.turns ?? 0) + 1;
                        const usage = msg.usage;
                        if (usage) {
                            result.usage.input += usage.input || 0;
                            result.usage.output += usage.output || 0;
                            result.usage.cacheRead += usage.cacheRead || 0;
                            result.usage.cacheWrite += usage.cacheWrite || 0;
                            result.usage.cost += usage.cost?.total || 0;
                            result.usage.contextTokens = usage.totalTokens || 0;
                        }
                        if (!result.model && msg.model) result.model = msg.model;
                        if (msg.stopReason) result.stopReason = msg.stopReason;
                        if (msg.errorMessage) result.errorMessage = msg.errorMessage;
                    }
                    onUpdate?.(result);
                }

                if (event.type === "tool_result_end" && event.message) {
                    result.messages.push(event.message as Message);
                    onUpdate?.(result);
                }
            };

            proc.stdout!.on("data", (data: Buffer) => {
                buffer += data.toString();
                const lines = buffer.split("\n");
                buffer = lines.pop() || "";
                for (const line of lines) processLine(line);
            });

            proc.stderr!.on("data", (data: Buffer) => {
                result.stderr = (result.stderr + data.toString()).slice(-4096);
            });

            proc.on("close", (code) => {
                if (buffer.trim()) processLine(buffer);
                resolve(code ?? 0);
            });

            proc.on("error", (err) => {
                result.errorMessage = err.message;
                resolve(1);
            });

            let abortHandler: (() => void) | null = null;
            if (signal) {
                abortHandler = () => {
                    wasAborted = true;
                    proc.kill("SIGTERM");
                    setTimeout(() => {
                        if (!proc.killed) proc.kill("SIGKILL");
                    }, 5000);
                };
                if (signal.aborted) abortHandler();
                else signal.addEventListener("abort", abortHandler, { once: true });
            }

            // Clean up abort listener on normal exit
            proc.on("close", () => {
                if (abortHandler && signal) {
                    signal.removeEventListener("abort", abortHandler);
                }
            });
        });

        result.exitCode = exitCode;
        if (wasAborted) {
            result.exitCode = 1;
            result.stopReason = "aborted";
        }
        return result;
    } finally {
        cleanupTempFiles(resolved.tmpPromptPath, resolved.tmpDir);
    }
}
