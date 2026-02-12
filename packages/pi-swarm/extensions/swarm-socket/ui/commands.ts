/**
 * /hive Command
 *
 * Prints swarm status and agent activity feeds to chat.
 * No interactive UI — just text output.
 *
 * Usage:
 *   /hive          — overview of all agents with recent activity
 *   /hive <name>   — detailed activity feed for a specific agent
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getSwarmState, type AgentInfo, cleanupSwarm, gracefulShutdown } from "../core/state.js";
import { getAgentActivity, clearActivity } from "./activity.js";
import { clearDashboard } from "./dashboard.js";
import { openDashboardOverlay } from "./overlay.js";
import { GENERAL_CHANNEL } from "../core/channels.js";
import { getIdentity } from "../core/identity.js";
import { statusIcon, eventIcon, formatAge } from "./format.js";

export function registerSwarmCommand(pi: ExtensionAPI): void {
    pi.registerCommand("hive", {
        description: "Show swarm status and agent activity. Use /hive <name> for a specific agent.",
        handler: async (args, ctx) => {
            const state = getSwarmState();
            if (!state) {
                ctx.ui.notify("No active swarm.", "info");
                return;
            }

            // If we have UI, open the interactive overlay
            if (ctx.hasUI) {
                const agentName = args?.trim();
                let focusAgent: string | undefined;

                if (agentName) {
                    // Resolve agent name (exact or partial match)
                    const agent = state.agents.get(agentName);
                    if (agent) {
                        focusAgent = agent.name;
                    } else {
                        const match = Array.from(state.agents.values()).find(
                            a => a.name.includes(agentName)
                        );
                        if (match) {
                            focusAgent = match.name;
                        } else {
                            ctx.ui.notify(`Agent "${agentName}" not found.`, "warning");
                            return;
                        }
                    }
                }

                openDashboardOverlay(ctx, focusAgent);
                return;
            }

            // Fallback: text output for non-interactive contexts
            const agentName = args?.trim();

            if (agentName) {
                // Detail view for specific agent
                const agent = state.agents.get(agentName);
                if (!agent) {
                    // Try partial match
                    const match = Array.from(state.agents.values()).find(
                        a => a.name.includes(agentName)
                    );
                    if (match) {
                        printAgentDetail(pi, match);
                    } else {
                        ctx.ui.notify(`Agent "${agentName}" not found.`, "warning");
                    }
                } else {
                    printAgentDetail(pi, agent);
                }
            } else {
                // Overview of all agents
                printOverview(pi, state);
            }
        },
    });

    pi.registerCommand("swarm-kill", {
        description: "Kill the active swarm — stops all agents (including sub-agents) and cleans up.",
        handler: async (_args, ctx) => {
            const state = getSwarmState();
            if (!state) {
                ctx.ui.notify("No active swarm to kill.", "info");
                return;
            }

            const count = state.agents.size;
            await cleanupSwarm();
            clearActivity();
            clearDashboard(true);

            ctx.ui.notify(`Killed swarm (${count} agents).`, "info");
        },
    });

    pi.registerCommand("swarm-stop", {
        description: "Gracefully stop the active swarm — asks agents to finish up, waits 30s, then kills stragglers.",
        handler: async (_args, ctx) => {
            const state = getSwarmState();
            if (!state) {
                ctx.ui.notify("No active swarm to stop.", "info");
                return;
            }

            if (!state.group) {
                ctx.ui.notify("Cannot graceful-stop: no channel group (coordinator swarms must be stopped by their queen).", "warning");
                return;
            }

            ctx.ui.notify("Sending shutdown signal to all agents (30s timeout)...", "info");

            const identity = getIdentity();
            const sendInstruct = (instruction: string) => {
                // Broadcast shutdown instruction via general channel
                const generalClient = state.queenClients.get(GENERAL_CHANNEL);
                if (generalClient?.connected) {
                    try {
                        generalClient.send({
                            msg: instruction,
                            data: {
                                type: "instruct",
                                from: identity.name,
                                instruction,
                            },
                        });
                    } catch { /* ignore */ }
                }
            };

            await gracefulShutdown(sendInstruct);
            clearActivity();
            clearDashboard(true);

            ctx.ui.notify("Swarm stopped gracefully.", "info");
        },
    });
}

function printOverview(pi: ExtensionAPI, state: ReturnType<typeof getSwarmState>): void {
    if (!state) return;

    const agents = Array.from(state.agents.values());
    const total = agents.length;
    const done = agents.filter(a => a.status === "done").length;
    const running = agents.filter(a => a.status === "running" || a.status === "starting").length;
    const blocked = agents.filter(a => a.status === "blocked").length;

    let text = `**🐝 Swarm** — ${done}/${total} complete`;
    if (running > 0) text += ` • ${running} running`;
    if (blocked > 0) text += ` • ${blocked} blocked`;
    text += "\n";

    if (state.taskDirPath) {
        text += `Task dir: \`${state.taskDirPath}\`\n`;
    }
    text += "\n";

    // Group agents by swarm for display
    const bySwarm = new Map<string, AgentInfo[]>();
    for (const agent of agents) {
        if (!bySwarm.has(agent.swarm)) bySwarm.set(agent.swarm, []);
        bySwarm.get(agent.swarm)!.push(agent);
    }

    for (const [swarmName, swarmAgents] of bySwarm) {
        if (bySwarm.size > 1) {
            text += `### ${swarmName}\n`;
        }

        for (const agent of swarmAgents) {
            const icon = statusIcon(agent.status);
            const role = agent.role === "coordinator" ? "coord" : "agent";

            text += `${icon} **${agent.name}** (${role}) — ${agent.status}`;

            if (agent.doneSummary) {
                text += `\n  ${agent.doneSummary}`;
            } else if (agent.blockerDescription) {
                text += `\n  ⚠ ${agent.blockerDescription}`;
            }

            // Last 3 activity events as preview
            const activity = getAgentActivity(agent.name);
            if (activity.length > 0) {
                const recent = activity.slice(-3);
                text += `\n  Recent:`;
                for (const ev of recent) {
                    text += `\n    ${eventIcon(ev.type)} ${ev.summary}`;
                }
            }

            text += "\n\n";
        }
    }

    text += `_Use \`/hive <name>\` to see full activity for an agent._`;

    pi.sendMessage({
        customType: "swarm-hive",
        content: text,
        display: true,
    }, { deliverAs: "followUp" });
}

function printAgentDetail(pi: ExtensionAPI, agent: AgentInfo): void {
    const icon = statusIcon(agent.status);
    let text = `**${icon} ${agent.name}** (${agent.role}, ${agent.swarm}) — ${agent.status}\n`;

    if (agent.doneSummary) {
        text += `✓ ${agent.doneSummary}\n`;
    }
    if (agent.blockerDescription) {
        text += `⚠ ${agent.blockerDescription}\n`;
    }

    text += "\n**Activity Feed**\n";

    const activity = getAgentActivity(agent.name);

    if (activity.length === 0) {
        text += "(no activity recorded yet)\n";
    } else {
        for (const ev of activity) {
            const age = formatAge(ev.timestamp);
            const ic = eventIcon(ev.type);
            text += `\`${age.padStart(7)}\` ${ic} ${ev.summary}\n`;
        }
    }

    pi.sendMessage({
        customType: "swarm-hive",
        content: text,
        display: true,
    }, { deliverAs: "followUp" });
}
