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

import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { SwarmServer } from "../core/server.js";
import { UnixTransportServer } from "../transport/unix-socket.js";
import {
    type AgentInfo,
    type SwarmState,
    type SubAgentRelay,
    getSwarmState,
    getSwarmGeneration,
    setSwarmState,
    updateAgentStatus,
    cleanupSwarm,
    parseSubRelay,
    getParentClient,
} from "../core/state.js";
import type { RelayEvent, RelayMessage } from "../transport/protocol.js";
import { getIdentity } from "../core/identity.js";
import { createHiveMindFile } from "../core/prompts.js";
import { spawnAgent } from "../core/spawn.js";
import { discoverAgents } from "../core/agents.js";
import { updateDashboard } from "../ui/dashboard.js";
import { trackAgentOutput, clearActivity, pushSyntheticEvent } from "../ui/activity.js";

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

/**
 * Handle a sub-agent relay event that bubbled up from a coordinator.
 * Adds/updates the sub-agent in the queen's state so the dashboard can show it.
 * Also forwards the relay further up if we have a parent (passthrough for deep trees).
 *
 * Accepts the new RelayEvent format. Legacy SubAgentRelay is converted before calling this.
 */
function handleRelayEvent(state: SwarmState, relay: RelayEvent, ctx: any): void {
    const existing = state.agents.get(relay.name);

    if (relay.event === "register") {
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
    } else if (relay.event === "done") {
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
    } else if (relay.event === "blocked") {
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
    } else if (relay.event === "disconnected") {
        if (existing) {
            updateAgentStatus(relay.name, "disconnected");
        }
        pushSyntheticEvent(relay.name, "message", "disconnected");
    } else if (relay.event === "nudge") {
        pushSyntheticEvent(relay.name, "message", `hive-mind: ${relay.reason || ""}`);
    }

    updateDashboard(ctx);

    // Passthrough: if we have a parent, forward the relay up (deep trees)
    const pc = getParentClient();
    if (pc && pc.connected) {
        pc.relay(relay);
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
            let socketPath: string;
            let server: SwarmServer | null = null;

            // Generation counter — declared here so all closures below can
            // reference it. Assigned after setSwarmState() later in this function.
            let gen: number;

            {
                socketPath = generateSocketPath();
                server = new SwarmServer(new UnixTransportServer(socketPath), {
                    onRegister: (client) => {
                        if (getSwarmGeneration() !== gen) return;
                        updateAgentStatus(client.name, "running");
                        updateDashboard(ctx);
                        // Relay registration up to parent
                        const pc = getParentClient();
                        if (pc && pc.connected) {
                            const agent = agentMap.get(client.name);
                            pc.relay({
                                event: "register",
                                name: client.name,
                                role: client.role,
                                swarm: client.swarm || "unknown",
                                code: agent?.code || "?",
                            });
                        }
                    },
                    onMessage: (_from, msg) => {
                        if (getSwarmGeneration() !== gen) return;
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
                        } else if (msg.type === "relay") {
                            // First-class relay message
                            const relayMsg = msg as RelayMessage;
                            handleRelayEvent(state, relayMsg.relay, ctx);
                        } else if (msg.type === "nudge") {
                            const nudgeMsg = msg as { type: "nudge"; reason: string };
                            const reason = nudgeMsg.reason;

                            // Backward compat: try parsing as legacy JSON-in-nudge relay
                            const legacyRelay = parseSubRelay(reason);
                            if (legacyRelay) {
                                handleRelayEvent(state, {
                                    event: legacyRelay.type,
                                    name: legacyRelay.name,
                                    role: legacyRelay.role,
                                    swarm: legacyRelay.swarm,
                                    code: legacyRelay.code,
                                    summary: legacyRelay.summary,
                                    description: legacyRelay.description,
                                    reason: legacyRelay.reason,
                                }, ctx);
                                return;
                            }

                            state.onNudge?.(reason, _from.name);
                        } else if (msg.type === "progress") {
                            // Progress messages: update agent info and activity feed
                            const progressMsg = msg as { type: "progress"; phase?: string; percent?: number; detail?: string };
                            const agent = state.agents.get(_from.name);
                            if (agent) {
                                if (progressMsg.phase != null) agent.progressPhase = progressMsg.phase;
                                if (progressMsg.percent != null) agent.progressPercent = progressMsg.percent;
                                if (progressMsg.detail != null) agent.progressDetail = progressMsg.detail;
                            }
                            const detail = progressMsg.detail || progressMsg.phase || "progress";
                            const pct = progressMsg.percent != null ? ` (${progressMsg.percent}%)` : "";
                            pushSyntheticEvent(_from.name, "message", `${detail}${pct}`);
                            updateDashboard(ctx);
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
                            const pc = getParentClient();
                            if (pc && pc.connected) {
                                pc.relay({
                                    event: "disconnected",
                                    name: client.name,
                                    role: client.role,
                                    swarm: client.swarm || "unknown",
                                    code: agent.code,
                                });
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
            const myCode = getIdentity().code;

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
                generation: 0,
                server,
                socketPath,
                agents: agentMap,
                hiveMindPath,
            };

            // Detect if we're a coordinator (have a parent socket to relay to)
            const parentClient = getParentClient();

            // Wire up notifications to pi.sendMessage + optional upward relay
            state.onAgentDone = (agentName, summary) => {
                if (getSwarmGeneration() !== gen) return;
                updateDashboard(ctx);
                if (parentClient && parentClient.connected) {
                    const agent = agentMap.get(agentName);
                    parentClient.relay({
                        event: "done",
                        name: agentName, role: agent?.role || "agent",
                        swarm: agent?.swarm || "unknown", code: agent?.code || "?",
                        summary,
                    });
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

            state.onBlocker = (agentName, description, _from) => {
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
                if (parentClient && parentClient.connected) {
                    const agent = state.agents.get(agentName);
                    parentClient.relay({
                        event: "blocked",
                        name: agentName, role: agent?.role || "agent",
                        swarm: agent?.swarm || "unknown", code: agent?.code || "?",
                        description,
                    });
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
                if (parentClient && parentClient.connected) {
                    const agent = Array.from(state.agents.values()).find(a => a.name === from);
                    parentClient.relay({
                        event: "nudge",
                        name: from, role: agent?.role || "agent",
                        swarm: agent?.swarm || "unknown", code: agent?.code || "?",
                        reason,
                    });
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

                // Capture stderr for debugging
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

                if (proc.stdout) {
                    trackAgentOutput(agentDef.name, proc.stdout);
                }
            }

            // Timeout for agents stuck in "starting"
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
