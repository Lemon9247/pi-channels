/**
 * Swarm Dashboard
 *
 * Live-updating widget showing swarm agent status.
 * Uses ctx.ui.setWidget() for a persistent display above the editor.
 * Flat list grouped by swarm — no hierarchical tree.
 */

import { getSwarmState, type AgentInfo, type AgentStatus } from "../core/state.js";
import { getAgentActivity, getAgentUsage, getAggregateUsage } from "./activity.js";
import { formatTokens } from "./format.js";

// Store ctx reference for dashboard updates triggered outside tool execution
let dashboardCtx: any = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

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

/**
 * Summarize agent statuses from a list of agents.
 */
function summarize(agents: AgentInfo[]) {
    const total = agents.length;
    const done = agents.filter(a => a.status === "done").length;
    const running = agents.filter(a => a.status === "running" || a.status === "starting").length;
    const blocked = agents.filter(a => a.status === "blocked").length;
    const failed = agents.filter(a => a.status === "crashed" || a.status === "disconnected").length;
    return { total, done, running, blocked, failed };
}

/**
 * Update the swarm dashboard widget with current state.
 * Call this whenever agent status changes.
 */
export function updateDashboard(ctx?: any): void {
    if (ctx) dashboardCtx = ctx;
    const c = ctx || dashboardCtx;
    if (!c || !c.hasUI) return;

    const state = getSwarmState();
    if (!state) {
        c.ui.setWidget("swarm-dashboard", undefined);
        c.ui.setStatus("swarm", undefined);
        stopRefresh();
        return;
    }

    // Start periodic refresh while agents are running, stop when all done
    const agents_ = Array.from(state.agents.values());
    const anyRunning = agents_.some(a => a.status === "running" || a.status === "starting");
    if (anyRunning) {
        startRefresh();
    } else {
        stopRefresh();
    }

    // Status bar: compact summary with aggregate cost
    const agents = Array.from(state.agents.values());
    const { total, done, running, blocked, failed } = summarize(agents);
    let statusText = `🐝 ${done}/${total}`;
    if (running > 0) statusText += ` ⏳${running}`;
    if (blocked > 0) statusText += ` ⚠${blocked}`;
    if (failed > 0) statusText += ` ✗${failed}`;
    const aggregate = getAggregateUsage();
    if (aggregate.cost > 0) statusText += ` $${aggregate.cost.toFixed(2)}`;
    if (done === total) statusText += " ✓";
    c.ui.setStatus("swarm", statusText);

    // Widget: flat list grouped by swarm
    const widgetLines: string[] = [];

    widgetLines.push(`🐝 Swarm — ${done}/${total} complete`);
    if (state.taskDirPath) {
        widgetLines.push(`   task: ${state.taskDirPath}`);
    }

    // Group agents by swarm
    const bySwarm = new Map<string, AgentInfo[]>();
    for (const agent of agents) {
        if (!bySwarm.has(agent.swarm)) bySwarm.set(agent.swarm, []);
        bySwarm.get(agent.swarm)!.push(agent);
    }

    for (const [swarmName, swarmAgents] of bySwarm) {
        if (bySwarm.size > 1) {
            widgetLines.push(`   ─ ${swarmName} ─`);
        }

        for (let i = 0; i < swarmAgents.length; i++) {
            const agent = swarmAgents[i];
            const isLast = i === swarmAgents.length - 1;
            const branch = isLast ? "└ " : "├ ";
            const icon = statusIcon(agent.status);
            const role = agent.role === "coordinator" ? "co" : "ag";

            // Compact usage: "3t ↑12k $0.02"
            const usage = getAgentUsage(agent.name);
            let usageStr = "";
            if (usage.turns) {
                const parts: string[] = [];
                parts.push(`${usage.turns}t`);
                if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
                if (usage.cost) parts.push(`$${usage.cost.toFixed(2)}`);
                usageStr = parts.join(" ");
            }

            let detail = "";
            if (agent.status === "done" && agent.doneSummary) {
                detail = agent.doneSummary.length > 50
                    ? agent.doneSummary.slice(0, 50) + "…"
                    : agent.doneSummary;
            } else if (agent.status === "blocked" && agent.blockerDescription) {
                detail = agent.blockerDescription.length > 50
                    ? agent.blockerDescription.slice(0, 50) + "…"
                    : agent.blockerDescription;
            } else if (agent.progressPhase || agent.progressPercent != null || agent.progressDetail) {
                const parts: string[] = [];
                if (agent.progressPhase) parts.push(agent.progressPhase);
                if (agent.progressPercent != null) parts.push(`${agent.progressPercent}%`);
                if (agent.progressDetail) parts.push(agent.progressDetail);
                detail = parts.join(" — ");
                if (detail.length > 50) detail = detail.slice(0, 50) + "…";
            } else {
                const activity = getAgentActivity(agent.name);
                const last = activity.length > 0 ? activity[activity.length - 1] : null;
                if (last) {
                    detail = last.summary.length > 50
                        ? last.summary.slice(0, 50) + "…"
                        : last.summary;
                } else {
                    detail = agent.status;
                }
            }

            const usagePart = usageStr ? ` ${usageStr} ` : " ";
            widgetLines.push(`   ${branch}${icon} ${agent.name} (${role})${usagePart}${detail}`);
        }
    }

    c.ui.setWidget("swarm-dashboard", widgetLines, { placement: "belowEditor" });
}

function startRefresh(): void {
    if (refreshTimer) return;
    refreshTimer = setInterval(() => {
        updateDashboard();
    }, 3000);
}

function stopRefresh(): void {
    if (refreshTimer) {
        clearInterval(refreshTimer);
        refreshTimer = null;
    }
}

/**
 * Clear the dashboard (when swarm completes or is cleaned up).
 * Pass force=true to actually remove the widget (e.g. on session shutdown).
 */
export function clearDashboard(force: boolean = false): void {
    if (!dashboardCtx || !dashboardCtx.hasUI) return;
    stopRefresh();
    if (force) {
        dashboardCtx.ui.setWidget("swarm-dashboard", undefined);
        dashboardCtx.ui.setStatus("swarm", undefined);
    }
}
