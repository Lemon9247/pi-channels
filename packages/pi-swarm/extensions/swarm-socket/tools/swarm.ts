/**
 * Swarm Tool
 *
 * Non-blocking tool that spawns agents as background processes.
 * Returns immediately — results flow back via channel notifications.
 *
 * Creates a ChannelGroup with general + per-agent inbox channels.
 * Queen monitors all channels for status updates.
 */

import * as crypto from "node:crypto";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import type { Message } from "../../../../agent-channels/dist/index.js";
import {
    createSwarmChannelGroup,
    connectToMultiple,
    GENERAL_CHANNEL,
    QUEEN_INBOX,
    inboxName,
} from "../core/channels.js";
import {
    type AgentInfo,
    type SwarmState,
    getSwarmState,
    getSwarmGeneration,
    setSwarmState,
    updateAgentStatus,
    cleanupSwarm,
    getParentClients,
} from "../core/state.js";
import { getIdentity } from "../core/identity.js";
import { scaffoldTaskDir, scaffoldCoordinatorSubDir, type ScaffoldResult } from "../core/scaffold.js";
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
    agent: Type.Optional(Type.String({ description: "Name of a pre-defined agent to use" })),
    systemPrompt: Type.Optional(Type.String({ description: "Custom system prompt for inline agent" })),
    tools: Type.Optional(Type.Array(Type.String(), { description: "Tools for inline agent" })),
    model: Type.Optional(Type.String({ description: "Model for this agent" })),
    cwd: Type.Optional(Type.String({ description: "Working directory for this agent" })),
});

const TaskDirDef = Type.Object({
    path: Type.String({ description: "Path to the task directory for swarm coordination files" }),
    overview: Type.Optional(Type.String({ description: "Task overview for the coordination template" })),
});

const SwarmParams = Type.Object({
    agents: Type.Array(AgentDef, { description: "Agents to spawn in the swarm" }),
    taskDir: Type.Optional(TaskDirDef),
});

function generateSwarmId(): string {
    return crypto.randomBytes(4).toString("hex");
}

/** Minimal structural type for the tool execution context from pi. */
interface ToolContext {
    cwd: string;
    hasUI: boolean;
    ui: {
        setWidget(id: string, widget: unknown): void;
        setStatus(id: string, status: unknown): void;
        notify(msg: string, level: string): void;
    };
}

/**
 * Relay an event up to the parent swarm (coordinator → queen).
 * No-op if we're not a coordinator (no parent clients).
 */
function relayToParent(
    event: string,
    name: string,
    agent: AgentInfo | undefined,
    extra?: Record<string, unknown>,
): void {
    const clients = getParentClients();
    if (!clients) return;
    const queenClient = clients.get(QUEEN_INBOX);
    if (!queenClient?.connected) return;
    try {
        queenClient.send({
            msg: `relay: ${event}`,
            data: {
                type: "relay",
                relay: {
                    event,
                    name,
                    role: agent?.role || "agent",
                    swarm: agent?.swarm || "unknown",
                    ...extra,
                },
            },
        });
    } catch { /* ignore */ }
}

/**
 * Handle a relay event that a coordinator forwarded from a sub-agent.
 * Adds/updates the sub-agent in the queen's state for the dashboard.
 */
function handleRelayEvent(
    state: SwarmState,
    relay: Record<string, unknown>,
    ctx: ToolContext,
): void {
    const name = relay.name as string;
    const event = relay.event as string;
    const role = (relay.role as string) || "agent";
    const swarm = (relay.swarm as string) || "unknown";
    const existing = state.agents.get(name);

    if (event === "register") {
        if (!existing) {
            state.agents.set(name, {
                name,
                role: role as "coordinator" | "agent",
                swarm,
                task: "(sub-agent)",
                status: "running",
            });
        }
        pushSyntheticEvent(name, "message", `registered (${role}, ${swarm})`);
    } else if (event === "done") {
        const summary = relay.summary as string | undefined;
        if (existing) {
            updateAgentStatus(name, "done", { doneSummary: summary });
        } else {
            state.agents.set(name, {
                name,
                role: role as "coordinator" | "agent",
                swarm,
                task: "(sub-agent)",
                status: "done",
                doneSummary: summary,
            });
        }
        pushSyntheticEvent(name, "tool_end", `✓ done: ${summary || "completed"}`);
    } else if (event === "blocked") {
        const description = relay.description as string | undefined;
        if (existing) {
            updateAgentStatus(name, "blocked", { blockerDescription: description });
        } else {
            state.agents.set(name, {
                name,
                role: role as "coordinator" | "agent",
                swarm,
                task: "(sub-agent)",
                status: "blocked",
                blockerDescription: description,
            });
        }
        pushSyntheticEvent(name, "tool_end", `⚠ blocked: ${description || "unknown"}`);
    } else if (event === "disconnected") {
        if (existing) {
            updateAgentStatus(name, "disconnected");
        }
        pushSyntheticEvent(name, "message", "disconnected");
    } else if (event === "nudge") {
        pushSyntheticEvent(name, "message", `hive-mind: ${relay.reason || ""}`);
    }

    updateDashboard(ctx);

    // Passthrough: if we have parent channels, forward the relay up
    const parentClients = getParentClients();
    if (parentClients) {
        const queenInbox = parentClients.get(QUEEN_INBOX);
        if (queenInbox?.connected) {
            try {
                queenInbox.send({ msg: `relay: ${name} ${event}`, data: { type: "relay", relay } });
            } catch { /* ignore */ }
        }
    }
}

/**
 * Handle an incoming channel message from the queen's perspective.
 * Parses data.type to dispatch to appropriate handler.
 */
function handleQueenMessage(
    state: SwarmState,
    gen: number,
    msg: Message,
    fromChannel: string,
    agentMap: Map<string, AgentInfo>,
    ctx: ToolContext,
    pi: ExtensionAPI,
): void {
    if (getSwarmGeneration() !== gen) return;
    if (!msg.data || !msg.data.type) return;

    const type = msg.data.type as string;
    const senderName = (msg.data.from as string) || "unknown";

    switch (type) {
        case "register": {
            updateAgentStatus(senderName, "running");
            pushSyntheticEvent(senderName, "message", `registered (${msg.data.role || "agent"})`);
            updateDashboard(ctx);
            break;
        }

        case "done": {
            const summary = (msg.data.summary as string) || "";
            updateAgentStatus(senderName, "done", { doneSummary: summary });
            state.onAgentDone?.(senderName, summary);
            updateDashboard(ctx);
            relayToParent("done", senderName, agentMap.get(senderName), { summary });
            break;
        }

        case "blocker": {
            const description = (msg.data.description as string) || "";
            updateAgentStatus(senderName, "blocked", { blockerDescription: description });
            state.onBlocker?.(senderName, description);
            updateDashboard(ctx);
            relayToParent("blocked", senderName, agentMap.get(senderName), { description });
            break;
        }

        case "nudge": {
            const reason = (msg.data.reason as string) || msg.msg;
            state.onNudge?.(reason, senderName);
            relayToParent("nudge", senderName, agentMap.get(senderName), { reason });
            break;
        }

        case "progress": {
            const agent = state.agents.get(senderName);
            if (agent) {
                if (msg.data.phase != null) agent.progressPhase = msg.data.phase as string;
                if (msg.data.percent != null) agent.progressPercent = msg.data.percent as number;
                if (msg.data.detail != null) agent.progressDetail = msg.data.detail as string;
            }
            const detail = (msg.data.detail as string) || (msg.data.phase as string) || "progress";
            const pct = msg.data.percent != null ? ` (${msg.data.percent}%)` : "";
            pushSyntheticEvent(senderName, "message", `${detail}${pct}`);
            updateDashboard(ctx);
            break;
        }

        case "relay": {
            const relay = msg.data.relay as Record<string, unknown>;
            if (relay) {
                handleRelayEvent(state, relay, ctx);
            }
            break;
        }
    }
}

export function registerSwarmTool(pi: ExtensionAPI): void {
    pi.registerTool({
        name: "swarm",
        label: "Swarm",
        description:
            "Start a swarm of coordinated agents. Agents are spawned as background processes " +
            "and communicate via channels. Returns immediately — use swarm_status " +
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

            // Generation counter
            let gen: number;

            // Create channel group
            const swarmId = generateSwarmId();
            const agentNames = params.agents.map((a) => a.name);
            let group;
            try {
                group = await createSwarmChannelGroup(swarmId, agentNames);
            } catch (err) {
                return {
                    content: [{ type: "text", text: `Failed to create channel group: ${err}` }],
                    details: {},
                    isError: true,
                };
            }

            // Build agent info map
            const agentMap = new Map<string, AgentInfo>();
            for (const agentDef of params.agents) {
                agentMap.set(agentDef.name, {
                    name: agentDef.name,
                    role: agentDef.role,
                    swarm: agentDef.swarm,
                    task: agentDef.task,
                    status: "starting",
                });
            }

            // Scaffold task directory
            let taskDirPath: string | undefined;
            let scaffoldResult: ScaffoldResult | undefined;
            const parentTaskDir = process.env.PI_SWARM_TASK_DIR;

            if (params.taskDir) {
                taskDirPath = params.taskDir.path;
                scaffoldResult = scaffoldTaskDir(
                    taskDirPath,
                    params.taskDir.overview,
                    Array.from(agentMap.values()),
                );
            } else if (parentTaskDir) {
                const mySwarm = getIdentity().swarm || "default";
                scaffoldResult = scaffoldCoordinatorSubDir(
                    parentTaskDir,
                    mySwarm,
                    undefined,
                    Array.from(agentMap.values()),
                );
                taskDirPath = scaffoldResult.taskDirPath;
            }

            // Connect queen to all channels for monitoring
            const allChannelNames = [GENERAL_CHANNEL, QUEEN_INBOX, ...agentNames.map(inboxName)];
            let queenClients;
            try {
                queenClients = await connectToMultiple(group.path, allChannelNames);
            } catch (err) {
                await group.stop({ removeDir: true });
                return {
                    content: [{ type: "text", text: `Failed to connect queen to channels: ${err}` }],
                    details: {},
                    isError: true,
                };
            }

            // Set up state
            const state: SwarmState = {
                generation: 0,
                group,
                groupPath: group.path,
                agents: agentMap,
                taskDirPath,
                queenClients,
            };

            // Wire up notifications to pi.sendMessage
            state.onAgentDone = (_agentName, _summary) => {
                if (getSwarmGeneration() !== gen) return;
                // Dashboard update handled by handleQueenMessage after status update
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

            state.onBlocker = (agentName, description) => {
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
            };

            setSwarmState(state);
            gen = getSwarmGeneration();

            // Set up message listeners on all queen channels
            for (const [channelName, client] of queenClients.entries()) {
                client.on("message", (msg: Message) => {
                    if (getSwarmGeneration() !== gen) return;
                    const currentState = getSwarmState();
                    if (!currentState) return;
                    handleQueenMessage(currentState, gen, msg, channelName, agentMap, ctx, pi);
                });
            }

            // Cache agent discovery once for all spawns
            const knownAgents = discoverAgents(ctx.cwd);

            // Spawn all agents
            for (const agentDef of params.agents) {
                const agentInfo = agentMap.get(agentDef.name)!;
                const agentFileInfo = scaffoldResult?.agentFiles.get(agentDef.name);
                const { process: proc } = spawnAgent(
                    agentDef, group.path, taskDirPath, ctx.cwd, knownAgents, agentFileInfo,
                );

                agentInfo.process = proc;

                // Capture stderr for debugging
                let stderr = "";
                proc.stderr?.on("data", (data: Buffer) => {
                    stderr = (stderr + data.toString()).slice(-2048);
                });

                // Track process exit
                proc.on("close", (code: number | null) => {
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

                proc.on("error", (err: Error) => {
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
                            `Channels: ${group.path}\n` +
                            (taskDirPath ? `Task dir: ${taskDirPath}\n` : "") +
                            `\nAgents are running in the background. ` +
                            `Use \`swarm_status\` to check progress, \`swarm_instruct\` to send instructions.`,
                    },
                ],
                details: {
                    agentCount: params.agents.length,
                    groupPath: group.path,
                    taskDirPath,
                },
            };
        },

        renderCall(args, theme) {
            const count = args.agents?.length || 0;
            let text =
                theme.fg("toolTitle", theme.bold("swarm ")) +
                theme.fg("accent", `${count} agent${count !== 1 ? "s" : ""}`);

            if (args.taskDir?.path) {
                text += theme.fg("dim", ` task:${args.taskDir.path}`);
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
