/**
 * Swarm Status Tool
 *
 * Reports the current state of the swarm: which agents are running,
 * done, blocked, or disconnected.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { getSwarmState, type AgentInfo } from "../core/state.js";
import { getIdentity, buildChildrenMap } from "../core/identity.js";

function statusIcon(status: string): string {
    switch (status) {
        case "starting":
            return "🔄";
        case "running":
            return "⏳";
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
            const done = agents.filter((a) => a.status === "done").length;
            const blocked = agents.filter((a) => a.status === "blocked").length;
            const failed = agents.filter((a) => a.status === "crashed" || a.status === "disconnected").length;

            let report = `## Swarm Status\n\n`;
            report += `**Total:** ${agents.length} agents | `;
            report += `Running: ${running} | Done: ${done}`;
            if (blocked > 0) report += ` | Blocked: ${blocked}`;
            if (failed > 0) report += ` | Failed: ${failed}`;
            report += "\n\n";

            if (state.hiveMindPath) {
                report += `**Hive-mind:** ${state.hiveMindPath}\n\n`;
            }

            // Tree view using hierarchical codes
            const myCode = getIdentity().code;
            const { children } = buildChildrenMap(agents);

            function renderTree(code: string, indent: string): void {
                const kids = children.get(code) || [];
                for (const agent of kids) {
                    report += `${indent}- ${statusIcon(agent.status)} **${agent.name}** \`${agent.code}\` (${agent.role}, ${agent.swarm}) — ${agent.status}`;
                    if (agent.doneSummary) report += `\n${indent}  Done: ${agent.doneSummary}`;
                    if (agent.blockerDescription) report += `\n${indent}  Blocked: ${agent.blockerDescription}`;
                    report += "\n";
                    renderTree(agent.code, indent + "  ");
                }
            }

            renderTree(myCode, "");
            report += "\n";

            return {
                content: [{ type: "text", text: report }],
                details: {
                    total: agents.length,
                    running,
                    done,
                    blocked,
                    failed,
                    agents: agents.map((a) => ({
                        name: a.name,
                        role: a.role,
                        swarm: a.swarm,
                        status: a.status,
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

            const { total, running, done, blocked, failed } = details;
            let summary = theme.fg("toolTitle", theme.bold("swarm "));
            summary += theme.fg("accent", `${done}/${total} done`);
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
