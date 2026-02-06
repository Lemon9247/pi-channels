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
import { getSwarmState, type AgentInfo, type AgentStatus, cleanupSwarm, gracefulShutdown } from "../core/state.js";
import { getIdentity, buildChildrenMap } from "../core/identity.js";
import { getAgentActivity, clearActivity, type ActivityEvent } from "./activity.js";
import { clearDashboard } from "./dashboard.js";
import { serialize, type RelayedMessage } from "../transport/protocol.js";

function statusIcon(status: AgentStatus): string {
    switch (status) {
        case "starting": return "◌";
        case "running": return "●";
        case "done": return "✓";
        case "blocked": return "⚠";
        case "disconnected": return "✗";
        case "crashed": return "✗";
        default: return "?";
    }
}

function eventIcon(type: ActivityEvent["type"]): string {
    switch (type) {
        case "tool_start": return "▸";
        case "tool_end": return "▪";
        case "message": return "…";
        case "thinking": return "~";
        default: return " ";
    }
}

function formatAge(timestamp: number): string {
    const secs = Math.floor((Date.now() - timestamp) / 1000);
    if (secs < 60) return `${secs}s ago`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    return `${Math.floor(mins / 60)}h ago`;
}

export function registerSwarmCommand(pi: ExtensionAPI): void {
    pi.registerCommand("hive", {
        description: "Show swarm status and agent activity. Use /hive <name> for a specific agent.",
        handler: async (args, ctx) => {
            const state = getSwarmState();
            if (!state) {
                ctx.ui.notify("No active swarm.", "info");
                return;
            }

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

            if (!state.server) {
                ctx.ui.notify("Cannot graceful-stop: no server (coordinator swarms must be stopped by their queen).", "warning");
                return;
            }

            ctx.ui.notify("Sending shutdown signal to all agents (30s timeout)...", "info");

            // Bypass server routing — broadcast directly to all connected clients.
            const sendInstruct = (instruction: string) => {
                const msg = serialize({
                    from: "queen",
                    fromRole: "queen",
                    message: { type: "instruct" as const, instruction },
                } as RelayedMessage);
                for (const client of state.server!.getClients().values()) {
                    try {
                        if (!client.socket.destroyed) {
                            client.socket.write(msg);
                        }
                    } catch { /* socket may have closed */ }
                }
            };

            await gracefulShutdown(state.server, sendInstruct);
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

    if (state.hiveMindPath) {
        text += `Hive: \`${state.hiveMindPath}\`\n`;
    }
    text += "\n";

    // Build tree from hierarchical codes
    const myCode = getIdentity().code;
    const { children } = buildChildrenMap(agents);

    // Recursive tree render
    function renderTree(code: string, indent: string): void {
        const kids = children.get(code) || [];
        for (const agent of kids) {
            const icon = statusIcon(agent.status);
            const role = agent.role === "coordinator" ? "coord" : "agent";
            const codeTag = `\`${agent.code}\``;

            text += `${indent}${icon} **${agent.name}** ${codeTag} (${role}) — ${agent.status}`;

            if (agent.doneSummary) {
                text += `\n${indent}  ${agent.doneSummary}`;
            } else if (agent.blockerDescription) {
                text += `\n${indent}  ⚠ ${agent.blockerDescription}`;
            }

            // Last 3 activity events as preview
            const activity = getAgentActivity(agent.name);
            if (activity.length > 0) {
                const recent = activity.slice(-3);
                text += `\n${indent}  Recent:`;
                for (const ev of recent) {
                    text += `\n${indent}    ${eventIcon(ev.type)} ${ev.summary}`;
                }
            }

            text += "\n\n";

            // Recurse into children
            renderTree(agent.code, indent + "  ");
        }
    }

    renderTree(myCode, "");

    text += `_Use \`/hive <name>\` to see full activity for an agent._`;

    pi.sendMessage({
        customType: "swarm-hive",
        content: text,
        display: true,
    }, { deliverAs: "followUp" });
}

function printAgentDetail(pi: ExtensionAPI, agent: AgentInfo): void {
    const icon = statusIcon(agent.status);
    let text = `**${icon} ${agent.name}** \`${agent.code}\` (${agent.role}, ${agent.swarm}) — ${agent.status}\n`;

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
