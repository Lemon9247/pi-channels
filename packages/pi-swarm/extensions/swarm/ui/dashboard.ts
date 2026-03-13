/**
 * Swarm Dashboard
 *
 * Live-updating widget showing swarm agent status.
 * Uses ctx.ui.setWidget() for a persistent display above the editor.
 * Tree rendering: sub-agents nest under their parent via spawnedBy.
 */

import { getSwarmState, type AgentInfo } from "../core/state.js";
import { getAgentActivity, getAgentUsage, getAggregateUsage } from "./activity.js";
import { formatTokens, statusIcon, shortModelName } from "./format.js";
import { isDashboardOpen } from "./overlay.js";

// Store ctx reference for dashboard updates triggered outside tool execution
let dashboardCtx: any = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

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
 * Build a parent→children map from agents' spawnedBy field.
 * undefined key = top-level agents (no parent).
 *
 * If spawnedBy references a non-existent agent (orphaned sub-agent),
 * the sub-agent is promoted to top-level to prevent invisible agents.
 */
export function buildAgentTree(agents: AgentInfo[]): Map<string | undefined, AgentInfo[]> {
    const tree = new Map<string | undefined, AgentInfo[]>();
    const agentNames = new Set(agents.map(a => a.name));

    for (const agent of agents) {
        const parent = agent.spawnedBy;
        // Promote orphans (parent doesn't exist) to top-level
        const effectiveParent = (parent && agentNames.has(parent)) ? parent : undefined;
        if (!tree.has(effectiveParent)) tree.set(effectiveParent, []);
        tree.get(effectiveParent)!.push(agent);
    }
    return tree;
}

/**
 * Build the detail string for a single agent line.
 */
function agentDetail(agent: AgentInfo): string {
    if (agent.status === "done" && agent.doneSummary) {
        return agent.doneSummary.length > 50
            ? agent.doneSummary.slice(0, 50) + "…"
            : agent.doneSummary;
    }
    if (agent.status === "blocked" && agent.blockerDescription) {
        return agent.blockerDescription.length > 50
            ? agent.blockerDescription.slice(0, 50) + "…"
            : agent.blockerDescription;
    }
    if (agent.progressPhase || agent.progressPercent != null || agent.progressDetail) {
        const parts: string[] = [];
        if (agent.progressPhase) parts.push(agent.progressPhase);
        if (agent.progressPercent != null) parts.push(`${agent.progressPercent}%`);
        if (agent.progressDetail) parts.push(agent.progressDetail);
        const detail = parts.join(" — ");
        return detail.length > 50 ? detail.slice(0, 50) + "…" : detail;
    }
    const activity = getAgentActivity(agent.name);
    const last = activity.length > 0 ? activity[activity.length - 1] : null;
    if (last) {
        return last.summary.length > 50
            ? last.summary.slice(0, 50) + "…"
            : last.summary;
    }
    return agent.status;
}

/**
 * Build the role display string for an agent.
 */
function roleDisplay(agent: AgentInfo): string {
    if (agent.agentType && agent.model) {
        return `${agent.agentType}/${shortModelName(agent.model)}`;
    }
    if (agent.agentType) return agent.agentType;
    if (agent.model) {
        const role = agent.role === "coordinator" ? "co" : "ag";
        return `${role}/${shortModelName(agent.model)}`;
    }
    return agent.role === "coordinator" ? "co" : "ag";
}

/**
 * Recursively render agents in tree format.
 */
function renderAgentTree(
    tree: Map<string | undefined, AgentInfo[]>,
    parentName: string | undefined,
    indent: string,
    lines: string[],
): void {
    const children = tree.get(parentName) || [];
    for (let i = 0; i < children.length; i++) {
        const agent = children[i];
        const isLast = i === children.length - 1;
        const branch = isLast ? "└ " : "├ ";
        const childIndent = indent + (isLast ? "   " : "│  ");
        const icon = statusIcon(agent.status);
        const role = roleDisplay(agent);
        const detail = agentDetail(agent);

        // Compact usage
        const usage = getAgentUsage(agent.name);
        let usageStr = "";
        if (usage.turns) {
            const parts: string[] = [];
            parts.push(`${usage.turns}t`);
            if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
            if (usage.cost) parts.push(`$${usage.cost.toFixed(2)}`);
            usageStr = parts.join(" ");
        }
        const usagePart = usageStr ? ` ${usageStr} ` : " ";

        lines.push(`${indent}${branch}${icon} ${agent.name} (${role})${usagePart}${detail}`);

        // Recurse into sub-agents
        if (tree.has(agent.name)) {
            renderAgentTree(tree, agent.name, childIndent, lines);
        }
    }
}

/**
 * Update the swarm dashboard widget with current state.
 * Call this whenever agent status changes.
 */
export function updateDashboard(ctx?: any): void {
    if (ctx) dashboardCtx = ctx;
    const c = ctx || dashboardCtx;
    if (!c || !c.hasUI) return;

    // Skip widget/status updates while full-screen dashboard is open —
    // the widget is invisible anyway and the renders cause scroll corruption.
    if (isDashboardOpen()) return;

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
    const directAgents = agents.filter(a => !a.spawnedBy);
    const subAgents = agents.filter(a => a.spawnedBy);
    const { total: directTotal, done: directDone, running, blocked, failed } = summarize(directAgents);

    let statusText = `🐝 ${directDone}/${directTotal}`;
    if (running > 0) statusText += ` ⏳${running}`;
    if (blocked > 0) statusText += ` ⚠${blocked}`;
    if (failed > 0) statusText += ` ✗${failed}`;
    if (subAgents.length > 0) statusText += ` +${subAgents.length}sub`;
    const aggregate = getAggregateUsage();
    if (aggregate.cost > 0) statusText += ` $${aggregate.cost.toFixed(2)}`;
    if (directDone === directTotal) statusText += " ✓";
    c.ui.setStatus("swarm", statusText);

    // Widget: tree grouped by swarm, sub-agents nested under parents
    const widgetLines: string[] = [];

    const totalDone = agents.filter(a => a.status === "done").length;
    let summaryLine = `🐝 Swarm — ${directDone}/${directTotal} complete`;
    if (subAgents.length > 0) summaryLine += ` (+${subAgents.length} sub-agents)`;
    widgetLines.push(summaryLine);
    if (state.taskDirPath) {
        widgetLines.push(`   task: ${state.taskDirPath}`);
    }

    // Build tree from spawnedBy relationships
    const tree = buildAgentTree(agents);
    const topLevel = tree.get(undefined) || [];

    // Group top-level agents by swarm
    const bySwarm = new Map<string, AgentInfo[]>();
    for (const agent of topLevel) {
        if (!bySwarm.has(agent.swarm)) bySwarm.set(agent.swarm, []);
        bySwarm.get(agent.swarm)!.push(agent);
    }

    for (const [swarmName, swarmAgents] of bySwarm) {
        if (bySwarm.size > 1) {
            widgetLines.push(`   ─ ${swarmName} ─`);
        }

        // Render top-level agents with recursive sub-agent nesting
        for (let i = 0; i < swarmAgents.length; i++) {
            const agent = swarmAgents[i];
            const isLast = i === swarmAgents.length - 1;
            const branch = isLast ? "└ " : "├ ";
            const childIndent = "   " + (isLast ? "   " : "│  ");
            const icon = statusIcon(agent.status);
            const role = roleDisplay(agent);
            const detail = agentDetail(agent);

            const usage = getAgentUsage(agent.name);
            let usageStr = "";
            if (usage.turns) {
                const parts: string[] = [];
                parts.push(`${usage.turns}t`);
                if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
                if (usage.cost) parts.push(`$${usage.cost.toFixed(2)}`);
                usageStr = parts.join(" ");
            }
            const usagePart = usageStr ? ` ${usageStr} ` : " ";

            widgetLines.push(`   ${branch}${icon} ${agent.name} (${role})${usagePart}${detail}`);

            // Render sub-agents nested under this agent
            if (tree.has(agent.name)) {
                renderAgentTree(tree, agent.name, childIndent, widgetLines);
            }
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
