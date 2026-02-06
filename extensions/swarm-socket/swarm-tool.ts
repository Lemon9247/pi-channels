/**
 * Swarm Tool
 *
 * Non-blocking tool that spawns agents as background processes.
 * Returns immediately — results flow back via socket notifications.
 *
 * Two modes:
 * - Queen: creates socket server, spawns agents
 * - Coordinator: reuses existing socket, spawns sub-agents
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { SwarmServer } from "./server.js";
import { type AgentInfo, type SwarmState, type SubAgentRelay, getSwarmState, getSwarmGeneration, setSwarmState, updateAgentStatus, cleanupSwarm, parseSubRelay, getParentClient } from "./state.js";
import { updateDashboard } from "./dashboard.js";
import { trackAgentOutput, clearActivity, pushSyntheticEvent } from "./activity.js";
import { discoverAgents, type AgentConfig } from "./agents.js";

// Agent definition — pre-defined by name or inline
const AgentDef = Type.Object({
    name: Type.String({ description: "Unique agent name (e.g. 'agent a1')" }),
    role: Type.Union([Type.Literal("coordinator"), Type.Literal("agent")], {
        description: "Role in the swarm hierarchy",
    }),
    swarm: Type.String({ description: "Swarm this agent belongs to" }),
    task: Type.String({ description: "Task to delegate to this agent" }),
    // Pre-defined agent (by name from ~/.pi/agent/agents/)
    agent: Type.Optional(Type.String({ description: "Name of a pre-defined agent to use" })),
    // Inline definition
    systemPrompt: Type.Optional(Type.String({ description: "Custom system prompt for inline agent" })),
    tools: Type.Optional(Type.Array(Type.String(), { description: "Tools for inline agent" })),
    model: Type.Optional(Type.String({ description: "Model for this agent" })),
    cwd: Type.Optional(Type.String({ description: "Working directory for this agent" })),
});

const HiveMindDef = Type.Object({
    path: Type.String({ description: "Path to create/find the hive-mind file" }),
    overview: Type.Optional(Type.String({ description: "Task overview for the hive-mind template" })),
});

const SwarmParams = Type.Object({
    agents: Type.Array(AgentDef, { description: "Agents to spawn in the swarm" }),
    hiveMind: Type.Optional(HiveMindDef),
});

function generateSocketPath(): string {
    const id = crypto.randomBytes(4).toString("hex");
    return path.join(os.tmpdir(), `pi-swarm-${id}.sock`);
}

function createHiveMindFile(hiveMindPath: string, overview: string | undefined, agents: AgentInfo[]): void {
    // Don't overwrite an existing hive-mind file — a parent swarm may have created it
    if (fs.existsSync(hiveMindPath)) {
        return;
    }

    const title = overview || "Swarm Task";
    const agentList = agents
        .map((a) => `- **${a.name}** (${a.role}, swarm: ${a.swarm}): ${a.task}`)
        .join("\n");
    const statusList = agents.map((a) => `- [ ] ${a.name}`).join("\n");

    const content = `# Hive Mind: ${title}

## Task Overview
${overview || "(No overview provided)"}

## Agents
${agentList}

## Findings
(Agents: add your discoveries here. Be specific — file paths, line numbers, code snippets.)

## Questions
(Post questions here. Check back for answers from other agents.)

## Blockers
(If blocked, post here AND call hive_blocker.)

## Status
${statusList}
`;

    // Create parent directory if needed
    const dir = path.dirname(hiveMindPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(hiveMindPath, content, "utf-8");
}

function createSwarmSystemPrompt(hiveMindPath: string | undefined, agentName: string, role: string = "agent"): string {
    const hiveMindSection = hiveMindPath
        ? `The hive-mind file is at: ${hiveMindPath}`
        : "No hive-mind file was specified for this swarm.";

    return `
## Swarm Coordination

You are **${agentName}**, part of a coordinated swarm. You have three coordination tools:

- **hive_notify** — After updating the hive-mind file with findings, call this to nudge your teammates to check it. Include a brief reason.
- **hive_blocker** — If you're stuck on something that affects the swarm, call this immediately. Don't silently spin. Also post in the Blockers section of the hive-mind.
- **hive_done** — When your task is complete, call this with a one-line summary. This should be the LAST thing you do.

${hiveMindSection}

**Be proactive**: Update the hive-mind early and often. Nudge after every significant finding. When you receive a notification from a teammate, check the hive-mind — they found something that may affect your work.

**Keep socket messages minimal**: The reason/description/summary fields are short labels. Put detailed findings in the hive-mind file, not in the socket message.

**CRITICAL — Hive-mind file is shared**: Multiple agents write to the same hive-mind file. NEVER use the write tool to overwrite it. ALWAYS use the edit tool to surgically insert your content into the appropriate section. Read the file first to see what others have written, then use edit to add your findings below theirs. If you overwrite the file, you will destroy other agents' work.

**Always call hive_done when finished.** The swarm coordinator is waiting for your completion signal.
${role === "coordinator" ? `
## Coordinator Instructions

You are a **coordinator** — you spawn and manage sub-agents, then synthesize their work.

**Stay responsive**: The queen may send you instructions at any time. Instructions arrive between tool calls, so **never use long sleep commands**. When waiting for agents, poll with \`swarm_status\` every 5-10 seconds. Do NOT use \`bash sleep\` for more than 5 seconds.

**Reply via hive_notify**: Your chat messages do NOT reach the queen. If the queen sends you an instruction asking for information, you MUST respond using \`hive_notify\`. That's the only way your reply reaches the queen.

**Relay instructions down**: If the queen sends an instruction targeting one of your agents, use \`swarm_instruct\` to forward it.
` : ""}`;
}

function writePromptToTempFile(name: string, prompt: string): { dir: string; filePath: string } {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-swarm-"));
    const safeName = name.replace(/[^\w.-]+/g, "_");
    const filePath = path.join(tmpDir, `swarm-prompt-${safeName}.md`);
    fs.writeFileSync(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
    return { dir: tmpDir, filePath };
}

function spawnAgent(
    agentDef: typeof AgentDef extends { static: infer T } ? T : any,
    socketPath: string,
    hiveMindPath: string | undefined,
    defaultCwd: string,
    code: string,
    knownAgents?: Map<string, AgentConfig>,
): { process: ChildProcess; tmpDir?: string } {
    // Clone to avoid mutating caller's params
    agentDef = { ...agentDef };

    // Pre-defined agent — merge config defaults before building args
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

    // System prompt: combine agent-specific + swarm coordination instructions
    let systemPrompt = "";
    if (agentDef.systemPrompt) {
        systemPrompt = agentDef.systemPrompt + "\n\n";
    }
    systemPrompt += createSwarmSystemPrompt(hiveMindPath, agentDef.name, agentDef.role);

    const { dir: tmpDir, filePath: tmpPromptPath } = writePromptToTempFile(agentDef.name, systemPrompt);
    args.push("--append-system-prompt", tmpPromptPath);

    // Task as the prompt
    args.push(`Task: ${agentDef.task}`);

    // Environment variables for socket connection
    const env = {
        ...process.env,
        PI_SWARM_SOCKET: socketPath,
        PI_SWARM_AGENT_NAME: agentDef.name,
        PI_SWARM_AGENT_ROLE: agentDef.role,
        PI_SWARM_AGENT_SWARM: agentDef.swarm,
        PI_SWARM_CODE: code,
    };

    const proc = spawn("pi", args, {
        cwd: agentDef.cwd || defaultCwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,  // Own process group — enables killing entire subtree
        env,
    });

    // Clean up temp files when process exits
    proc.on("close", () => {
        try {
            fs.unlinkSync(tmpPromptPath);
        } catch { /* ignore */ }
        try {
            fs.rmdirSync(tmpDir);
        } catch { /* ignore */ }
    });

    return { process: proc, tmpDir };
}

/**
 * Handle a sub-agent relay message that bubbled up from a coordinator.
 * Adds/updates the sub-agent in the queen's state so the dashboard can show it.
 * Also forwards the relay further up if we have a parent (passthrough for deep trees).
 */
function handleSubAgentRelay(state: SwarmState, relay: SubAgentRelay, ctx: any): void {
    const existing = state.agents.get(relay.name);

    if (relay.type === "register") {
        if (!existing) {
            state.agents.set(relay.name, {
                name: relay.name,
                role: relay.role as "coordinator" | "agent",
                swarm: relay.swarm,
                task: "(sub-agent)",
                status: "running",
                code: relay.code,
            });
        }
        pushSyntheticEvent(relay.name, "message", `registered (${relay.role}, ${relay.swarm})`);
    } else if (relay.type === "done") {
        if (existing) {
            updateAgentStatus(relay.name, "done", { doneSummary: relay.summary });
        } else {
            state.agents.set(relay.name, {
                name: relay.name,
                role: relay.role as "coordinator" | "agent",
                swarm: relay.swarm,
                task: "(sub-agent)",
                status: "done",
                code: relay.code,
                doneSummary: relay.summary,
            });
        }
        pushSyntheticEvent(relay.name, "tool_end", `✓ done: ${relay.summary || "completed"}`);
    } else if (relay.type === "blocked") {
        if (existing) {
            updateAgentStatus(relay.name, "blocked", { blockerDescription: relay.description });
        } else {
            state.agents.set(relay.name, {
                name: relay.name,
                role: relay.role as "coordinator" | "agent",
                swarm: relay.swarm,
                task: "(sub-agent)",
                status: "blocked",
                code: relay.code,
                blockerDescription: relay.description,
            });
        }
        pushSyntheticEvent(relay.name, "tool_end", `⚠ blocked: ${relay.description || "unknown"}`);
    } else if (relay.type === "disconnected") {
        if (existing) {
            updateAgentStatus(relay.name, "disconnected");
        }
        pushSyntheticEvent(relay.name, "message", "disconnected");
    } else if (relay.type === "nudge") {
        pushSyntheticEvent(relay.name, "message", `hive-mind: ${relay.reason || ""}`);
    }
    // "nudge" relays are informational — don't change state, just update dashboard

    updateDashboard(ctx);

    // Passthrough: if we have a parent, forward the relay unchanged (deep trees)
    const pc = getParentClient();
    if (pc && pc.connected) {
        pc.nudge(JSON.stringify(relay));
    }
}

export function registerSwarmTool(pi: ExtensionAPI): void {
    pi.registerTool({
        name: "swarm",
        label: "Swarm",
        description:
            "Start a swarm of coordinated agents. Agents are spawned as background processes " +
            "and communicate via a shared Unix socket. Returns immediately — use swarm_status " +
            "to check progress and swarm_instruct to send instructions. " +
            "Results and notifications arrive asynchronously between your tool calls.",
        parameters: SwarmParams,

        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            // Check for existing swarm — clean up if all agents are finished
            const existingState = getSwarmState();
            if (existingState) {
                const allFinished = Array.from(existingState.agents.values()).every(
                    (a) => a.status === "done" || a.status === "crashed" || a.status === "disconnected",
                );
                if (allFinished) {
                    await cleanupSwarm();
                    clearActivity();
                } else {
                    return {
                        content: [
                            {
                                type: "text",
                                text: "A swarm is already active with running agents. Check swarm_status or wait for completion.",
                            },
                        ],
                        details: {},
                        isError: true,
                    };
                }
            }

            // Always create a new socket for this swarm.
            // Queen creates a socket for coordinators. Coordinators create their own
            // socket for sub-agents. Per-swarm sockets give structural isolation —
            // agents in different swarms are on different buses.
            let socketPath: string;
            let server: SwarmServer | null = null;

            // Generation counter — declared here so all closures below can
            // reference it. Assigned after setSwarmState() later in this function.
            let gen: number;

            {
                socketPath = generateSocketPath();
                server = new SwarmServer(socketPath, {
                    onRegister: (client) => {
                        if (getSwarmGeneration() !== gen) return;
                        // Mark agent as running when it registers
                        updateAgentStatus(client.name, "running");
                        updateDashboard(ctx);
                        // Relay registration up to parent
                        const pc = getParentClient();
                        if (pc && pc.connected) {
                            const agent = agentMap.get(client.name);
                            const relay: SubAgentRelay = {
                                sub: true,
                                type: "register",
                                name: client.name,
                                role: client.role,
                                swarm: client.swarm || "unknown",
                                code: agent?.code || "?",
                            };
                            pc.nudge(JSON.stringify(relay));
                        }
                    },
                    onMessage: (_from, msg) => {
                        if (getSwarmGeneration() !== gen) return;
                        // Monitor ALL messages server-side
                        const state = getSwarmState();
                        if (!state) return;

                        if (msg.type === "done") {
                            const doneMsg = msg as { type: "done"; summary: string };
                            updateAgentStatus(_from.name, "done", { doneSummary: doneMsg.summary });
                            state.onAgentDone?.(_from.name, doneMsg.summary);
                        } else if (msg.type === "blocker") {
                            const blockerMsg = msg as { type: "blocker"; description: string };
                            updateAgentStatus(_from.name, "blocked", { blockerDescription: blockerMsg.description });
                            state.onBlocker?.(_from.name, blockerMsg.description, _from.name);
                        } else if (msg.type === "nudge") {
                            const nudgeMsg = msg as { type: "nudge"; reason: string };
                            const reason = nudgeMsg.reason;

                            // Parse sub-agent relay messages from coordinators
                            const relay = parseSubRelay(reason);
                            if (relay) {
                                handleSubAgentRelay(state, relay, ctx);
                                return; // Don't pass relay messages as nudges
                            }

                            state.onNudge?.(reason, _from.name);
                        }
                    },
                    onDisconnect: (client) => {
                        if (getSwarmGeneration() !== gen) return;
                        const state = getSwarmState();
                        if (!state) return;
                        const agent = state.agents.get(client.name);
                        if (agent && agent.status !== "done") {
                            updateAgentStatus(client.name, "disconnected");
                            updateDashboard(ctx);
                            // Relay disconnection up to parent
                            const pc = getParentClient();
                            if (pc && pc.connected) {
                                const relay: SubAgentRelay = {
                                    sub: true,
                                    type: "disconnected",
                                    name: client.name,
                                    role: client.role,
                                    swarm: client.swarm || "unknown",
                                    code: agent.code,
                                };
                                pc.nudge(JSON.stringify(relay));
                            }
                        }
                    },
                });

                try {
                    await server.start();
                } catch (err) {
                    return {
                        content: [{ type: "text", text: `Failed to start swarm socket: ${err}` }],
                        details: {},
                        isError: true,
                    };
                }
            }

            // My code in the hierarchy (queen="0", coordinators="0.1", etc.)
            const myCode = process.env.PI_SWARM_CODE || "0";

            // Build agent info with hierarchical codes
            const agentMap = new Map<string, AgentInfo>();
            for (let i = 0; i < params.agents.length; i++) {
                const agentDef = params.agents[i];
                const childCode = `${myCode}.${i + 1}`;
                agentMap.set(agentDef.name, {
                    name: agentDef.name,
                    role: agentDef.role,
                    swarm: agentDef.swarm,
                    task: agentDef.task,
                    status: "starting",
                    code: childCode,
                });
            }

            // Create hive-mind file
            let hiveMindPath: string | undefined;
            if (params.hiveMind) {
                hiveMindPath = params.hiveMind.path;
                createHiveMindFile(
                    hiveMindPath,
                    params.hiveMind.overview,
                    Array.from(agentMap.values()),
                );
            }

            // Set up state
            const state: SwarmState = {
                generation: 0,  // Placeholder — setSwarmState() assigns the real value
                server,
                socketPath,
                agents: agentMap,
                hiveMindPath,
            };

            // Detect if we're a coordinator (have a parent socket to relay to)
            const parentClient = getParentClient();
            const isCoordinator = !!parentClient;

            // Wire up notifications to pi.sendMessage + optional upward relay
            state.onAgentDone = (agentName, summary) => {
                if (getSwarmGeneration() !== gen) return;
                updateDashboard(ctx);
                // Relay up to parent
                if (parentClient && parentClient.connected) {
                    const agent = agentMap.get(agentName);
                    const relay: SubAgentRelay = {
                        sub: true, type: "done",
                        name: agentName, role: agent?.role || "agent",
                        swarm: agent?.swarm || "unknown", code: agent?.code || "?",
                        summary,
                    };
                    parentClient.nudge(JSON.stringify(relay));
                }
            };

            state.onAllDone = () => {
                if (getSwarmGeneration() !== gen) return;
                pi.sendMessage(
                    {
                        customType: "swarm-complete",
                        content:
                            "🐝 **All swarm agents have completed.**\n\n" +
                            "Read the hive-mind file and agent reports to synthesize findings. " +
                            "Use `swarm_status` to see individual results.",
                        display: true,
                    },
                    { deliverAs: "followUp", triggerTurn: true },
                );
                updateDashboard(ctx);
            };

            state.onBlocker = (agentName, description, from) => {
                if (getSwarmGeneration() !== gen) return;
                pi.sendMessage(
                    {
                        customType: "swarm-blocker",
                        content: `⚠️ **Agent ${agentName} is blocked:** ${description}\n\nUse \`swarm_instruct\` to help, or check the hive-mind file.`,
                        display: true,
                    },
                    { deliverAs: "steer" },
                );
                updateDashboard(ctx);
                // Relay up to parent
                if (parentClient && parentClient.connected) {
                    const agent = state.agents.get(agentName);
                    const relay: SubAgentRelay = {
                        sub: true, type: "blocked",
                        name: agentName, role: agent?.role || "agent",
                        swarm: agent?.swarm || "unknown", code: agent?.code || "?",
                        description,
                    };
                    parentClient.nudge(JSON.stringify(relay));
                }
            };

            state.onNudge = (reason, from) => {
                if (getSwarmGeneration() !== gen) return;
                pi.sendMessage(
                    {
                        customType: "swarm-nudge",
                        content: `🔔 **${from}** updated the hive-mind: ${reason}`,
                        display: true,
                    },
                    { deliverAs: "followUp" },
                );
                // Relay up to parent
                if (parentClient && parentClient.connected) {
                    const agent = Array.from(state.agents.values()).find(a => a.name === from);
                    const relay: SubAgentRelay = {
                        sub: true, type: "nudge",
                        name: from, role: agent?.role || "agent",
                        swarm: agent?.swarm || "unknown", code: agent?.code || "?",
                        reason,
                    };
                    parentClient.nudge(JSON.stringify(relay));
                }
            };

            setSwarmState(state);
            gen = getSwarmGeneration();

            // Cache agent discovery once for all spawns
            const knownAgents = discoverAgents(ctx.cwd);

            // Spawn all agents
            for (const agentDef of params.agents) {
                const agentInfo = agentMap.get(agentDef.name)!;
                const { process: proc } = spawnAgent(agentDef, socketPath, hiveMindPath, ctx.cwd, agentInfo.code, knownAgents);

                agentInfo.process = proc;

                // Capture stderr for debugging (declared before close handler that uses it)
                let stderr = "";
                proc.stderr?.on("data", (data) => {
                    stderr = (stderr + data.toString()).slice(-2048);
                });

                // Track process exit
                proc.on("close", (code) => {
                    if (getSwarmGeneration() !== gen) return;
                    const current = getSwarmState();
                    if (!current) return;
                    const agent = current.agents.get(agentDef.name);
                    if (agent && agent.status !== "done") {
                        if (code === 0) {
                            updateAgentStatus(agentDef.name, "done");
                        } else {
                            updateAgentStatus(agentDef.name, "crashed");
                            // Notify queen about the crash
                            pi.sendMessage(
                                {
                                    customType: "swarm-blocker",
                                    content: `💀 **${agentDef.name}** crashed (exit code ${code}).` +
                                        (stderr ? `\n\nLast stderr:\n\`\`\`\n${stderr.slice(-500)}\n\`\`\`` : ""),
                                    display: true,
                                },
                                { deliverAs: "steer" },
                            );
                        }
                        updateDashboard(ctx);
                    }
                });

                proc.on("error", (err) => {
                    if (getSwarmGeneration() !== gen) return;
                    updateAgentStatus(agentDef.name, "crashed");
                    pi.sendMessage(
                        {
                            customType: "swarm-blocker",
                            content: `💀 **${agentDef.name}** failed to start: ${err.message}`,
                            display: true,
                        },
                        { deliverAs: "steer" },
                    );
                    updateDashboard(ctx);
                });

                // Track agent stdout (JSON events) for activity feed
                if (proc.stdout) {
                    trackAgentOutput(agentDef.name, proc.stdout);
                }
            }

            // Timeout for agents stuck in "starting" — if they haven't registered
            // within 30 seconds, mark them crashed
            setTimeout(() => {
                if (getSwarmGeneration() !== gen) return;
                const current = getSwarmState();
                if (!current) return;
                for (const agent of current.agents.values()) {
                    if (agent.status === "starting") {
                        updateAgentStatus(agent.name, "crashed");
                        pi.sendMessage(
                            {
                                customType: "swarm-blocker",
                                content: `💀 **${agent.name}** failed to register within 30s — marked as crashed.`,
                                display: true,
                            },
                            { deliverAs: "steer" },
                        );
                    }
                }
                updateDashboard(ctx);
            }, 30_000);

            // Initialize dashboard
            updateDashboard(ctx);

            // Return immediately
            const agentList = params.agents
                .map((a) => `- **${a.name}** (${a.role}, swarm: ${a.swarm})`)
                .join("\n");

            return {
                content: [
                    {
                        type: "text",
                        text:
                            `Swarm started with ${params.agents.length} agent(s):\n${agentList}\n\n` +
                            `Socket: ${socketPath}\n` +
                            (hiveMindPath ? `Hive-mind: ${hiveMindPath}\n` : "") +
                            `\nAgents are running in the background. ` +
                            `Use \`swarm_status\` to check progress, \`swarm_instruct\` to send instructions.`,
                    },
                ],
                details: {
                    agentCount: params.agents.length,
                    socketPath,
                    hiveMindPath,
                },
            };
        },

        renderCall(args, theme) {
            const count = args.agents?.length || 0;
            let text =
                theme.fg("toolTitle", theme.bold("swarm ")) +
                theme.fg("accent", `${count} agent${count !== 1 ? "s" : ""}`);

            if (args.hiveMind?.path) {
                text += theme.fg("dim", ` hive:${args.hiveMind.path}`);
            }

            for (const a of (args.agents || []).slice(0, 4)) {
                const preview = a.task.length > 50 ? `${a.task.slice(0, 50)}...` : a.task;
                text += `\n  ${theme.fg("accent", a.name)} (${a.role})${theme.fg("dim", ` ${preview}`)}`;
            }
            if (count > 4) {
                text += `\n  ${theme.fg("muted", `... +${count - 4} more`)}`;
            }

            return new Text(text, 0, 0);
        },

        renderResult(result, _opts, theme) {
            const text = result.content[0];
            const content = text?.type === "text" ? text.text : "(no output)";
            const color = result.isError ? "error" : "success";
            const icon = result.isError ? "✗" : "🐝";
            return new Text(`${icon} ${theme.fg(color, content)}`, 0, 0);
        },
    });
}
