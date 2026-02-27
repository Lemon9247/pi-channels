/**
 * Swarm Status Tool
 *
 * Reports the current state of the swarm: which agents are running,
 * done, blocked, or disconnected. Flat list grouped by swarm.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { getSwarmState, type AgentInfo } from "../core/state.js";
import { shortModelName } from "../ui/format.js";

function statusIcon(status: string): string {
    switch (status) {
        case "starting":
            return "🔄";
        case "running":
            return "⏳";
        case "idle":
            return "💤";
        case "done":
            return "✅";
        case "blocked":
            return "⚠️";
        case "disconnected":
            return "🔌";
        case "crashed":
            return "💥";
        default:
            return "❓";
    }
}

export function registerStatusTool(pi: ExtensionAPI): void {
    pi.registerTool({
        name: "swarm_status",
        label: "Swarm Status",
        description: "Check the current state of the running swarm — which agents are running, done, blocked, or disconnected.",
        parameters: Type.Object({}),
        async execute() {
            const state = getSwarmState();
            if (!state) {
                return {
                    content: [{ type: "text", text: "No active swarm." }],
                    details: {},
                };
            }

            const agents = Array.from(state.agents.values());
            const running = agents.filter((a) => a.status === "running" || a.status === "starting").length;
            const idle = agents.filter((a) => a.status === "idle").length;
            const done = agents.filter((a) => a.status === "done").length;
            const blocked = agents.filter((a) => a.status === "blocked").length;
            const failed = agents.filter((a) => a.status === "crashed" || a.status === "disconnected").length;

            let report = `## Swarm Status\n\n`;
            report += `**Total:** ${agents.length} agents | `;
            report += `Running: ${running}`;
            if (idle > 0) report += ` | Idle: ${idle}`;
            report += ` | Done: ${done}`;
            if (blocked > 0) report += ` | Blocked: ${blocked}`;
            if (failed > 0) report += ` | Failed: ${failed}`;
            report += "\n\n";

            if (state.taskDirPath) {
                report += `**Task dir:** ${state.taskDirPath}\n\n`;
            }

            // Group by swarm for display
            const bySwarm = new Map<string, AgentInfo[]>();
            for (const agent of agents) {
                if (!bySwarm.has(agent.swarm)) bySwarm.set(agent.swarm, []);
                bySwarm.get(agent.swarm)!.push(agent);
            }

            for (const [swarmName, swarmAgents] of bySwarm) {
                report += `### ${swarmName}\n`;
                for (const agent of swarmAgents) {
                    // Display archetype + model instead of just role
                    let roleDisplay: string;
                    if (agent.agentType && agent.model) {
                        roleDisplay = `${agent.agentType}/${shortModelName(agent.model)}`;
                    } else if (agent.agentType) {
                        roleDisplay = agent.agentType;
                    } else if (agent.model) {
                        const role = agent.role === "coordinator" ? "coordinator" : "agent";
                        roleDisplay = `${role}/${shortModelName(agent.model)}`;
                    } else {
                        roleDisplay = agent.role;
                    }

                    report += `- ${statusIcon(agent.status)} **${agent.name}** (${roleDisplay}) — ${agent.status}`;
                    if (agent.doneSummary) report += `\n  Done: ${agent.doneSummary}`;
                    if (agent.blockerDescription) report += `\n  Blocked: ${agent.blockerDescription}`;
                    if (agent.progressPhase || agent.progressPercent != null || agent.progressDetail) {
                        const parts: string[] = [];
                        if (agent.progressPhase) parts.push(agent.progressPhase);
                        if (agent.progressPercent != null) parts.push(`${agent.progressPercent}%`);
                        if (agent.progressDetail) parts.push(agent.progressDetail);
                        report += `\n  Progress: ${parts.join(" — ")}`;
                    }
                    report += "\n";
                }
                report += "\n";
            }

            return {
                content: [{ type: "text", text: report }],
                details: {
                    total: agents.length,
                    running,
                    idle,
                    done,
                    blocked,
                    failed,
                    agents: agents.map((a) => ({
                        name: a.name,
                        role: a.role,
                        swarm: a.swarm,
                        status: a.status,
                        model: a.model,
                        agentType: a.agentType,
                    })),
                },
            };
        },

        renderCall(_args, theme) {
            return new Text(theme.fg("toolTitle", theme.bold("swarm_status")), 0, 0);
        },

        renderResult(result, _opts, theme) {
            const text = result.content[0];
            if (!text || text.type !== "text") return new Text("(no output)", 0, 0);

            const details = result.details as any;
            if (!details || !details.total) {
                return new Text(theme.fg("muted", text.text), 0, 0);
            }

            const { total, running, idle, done, blocked, failed } = details;
            let summary = theme.fg("toolTitle", theme.bold("swarm "));
            summary += theme.fg("accent", `${done}/${total} done`);
            if (idle > 0) summary += theme.fg("muted", ` ${idle} idle`);
            if (running > 0) summary += theme.fg("warning", ` ${running} running`);
            if (blocked > 0) summary += theme.fg("error", ` ${blocked} blocked`);
            if (failed > 0) summary += theme.fg("error", ` ${failed} failed`);

            if (details.agents) {
                for (const a of details.agents) {
                    const icon = statusIcon(a.status);
                    summary += `\n  ${icon} ${theme.fg("accent", a.name)} (${a.role}/${a.swarm}) — ${a.status}`;
                }
            }

            return new Text(summary, 0, 0);
        },
    });
}
