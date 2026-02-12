/**
 * Interactive Dashboard Overlay
 *
 * Modal overlay component for detailed swarm observation.
 * Two view modes:
 *   - List: all agents with status, usage, current activity. Arrow key navigation.
 *   - Detail: single agent with task, full tool call history, channel messages.
 *
 * Reads from the same stores as the passive widget (activity.ts, state.ts).
 * Live-updates via a refresh timer while open.
 */

import type { TUI, Component } from "@mariozechner/pi-tui";
import { matchesKey, Key } from "@mariozechner/pi-tui";
import { getSwarmState, type AgentInfo } from "../core/state.js";
import { getAgentActivity, getAgentUsage, getAggregateUsage, type ActivityEvent } from "./activity.js";
import { formatToolCall, formatTokens, formatUsageStats, statusIcon, eventIcon, formatAge } from "./format.js";

// ─── Types ──────────────────────────────────────────────────────────

type ViewMode = "list" | "detail";

interface DashboardOptions {
    tui: TUI;
    theme: { fg: (color: string, text: string) => string; bg: (color: string, text: string) => string; bold: (text: string) => string };
    done: (result: void) => void;
    /** Pre-focus on a specific agent (from /hive <name>) */
    focusAgent?: string;
}

// ─── Overlay Component ──────────────────────────────────────────────

export class DashboardOverlay implements Component {
    private tui: TUI;
    private theme: DashboardOptions["theme"];
    private done: (result: void) => void;

    // State machine
    private viewMode: ViewMode = "list";
    private selectedIndex = 0;
    private scrollOffset = 0;
    private lastMaxScroll = 0;
    private detailAgent: string | null = null;

    // Live update timer
    private refreshTimer: ReturnType<typeof setInterval> | null = null;

    // Cache the sorted agent list for stable indexing
    private cachedAgents: AgentInfo[] = [];

    constructor(opts: DashboardOptions) {
        this.tui = opts.tui;
        this.theme = opts.theme;
        this.done = opts.done;

        // Always populate agent list on construction so handleInput works immediately
        this.refreshAgentList();

        // Pre-focus on a specific agent if requested
        if (opts.focusAgent) {
            const idx = this.cachedAgents.findIndex(a => a.name === opts.focusAgent);
            if (idx >= 0) {
                this.viewMode = "detail";
                this.detailAgent = opts.focusAgent;
                this.selectedIndex = idx;
                this.scrollOffset = 0;
            }
        }

        // Start live refresh (every 1.5s)
        this.startRefresh();
    }

    dispose(): void {
        this.stopRefresh();
    }

    invalidate(): void {
        // No cached render state to clear
    }

    // ─── Render ─────────────────────────────────────────────────────

    render(width: number): string[] {
        this.refreshAgentList();

        if (this.cachedAgents.length === 0) {
            return this.renderEmpty(width);
        }

        switch (this.viewMode) {
            case "list":
                return this.renderList(width);
            case "detail":
                return this.renderDetail(width);
        }
    }

    private renderEmpty(width: number): string[] {
        const { theme } = this;
        const lines: string[] = [];
        lines.push(theme.bold(theme.fg("accent", " 🐝 Agent Dashboard")));
        lines.push("");
        lines.push(theme.fg("muted", "  No active swarm."));
        lines.push("");
        lines.push(theme.fg("dim", "  Press ") + theme.fg("muted", "Esc") + theme.fg("dim", " or ") + theme.fg("muted", "q") + theme.fg("dim", " to close."));
        return lines;
    }

    // ─── List View ──────────────────────────────────────────────────

    private renderList(width: number): string[] {
        const { theme } = this;
        const lines: string[] = [];
        const agents = this.cachedAgents;

        // Header
        const aggregate = getAggregateUsage();
        const done = agents.filter(a => a.status === "done").length;
        let header = ` 🐝 Agent Dashboard — ${done}/${agents.length} complete`;
        if (aggregate.cost > 0) header += ` — $${aggregate.cost.toFixed(2)}`;
        lines.push(theme.bold(theme.fg("accent", header)));

        // Separator
        lines.push(theme.fg("border", " " + "─".repeat(Math.max(width - 2, 20))));

        // Agent rows
        const contentWidth = width - 4; // 2 padding on each side
        for (let i = 0; i < agents.length; i++) {
            const agent = agents[i];
            const isSelected = i === this.selectedIndex;
            const row = this.renderAgentRow(agent, contentWidth, isSelected);
            lines.push(row);
        }

        // Footer
        lines.push(theme.fg("border", " " + "─".repeat(Math.max(width - 2, 20))));
        lines.push(
            theme.fg("dim", "  ↑↓") + theme.fg("muted", " navigate") +
            theme.fg("dim", "  ⏎") + theme.fg("muted", " detail") +
            theme.fg("dim", "  Esc/q") + theme.fg("muted", " close")
        );

        return lines;
    }

    private renderAgentRow(agent: AgentInfo, contentWidth: number, isSelected: boolean): string {
        const { theme } = this;
        const icon = statusIcon(agent.status);
        const role = agent.role === "coordinator" ? "co" : "ag";

        // Usage stats
        const usage = getAgentUsage(agent.name);
        let usageParts: string[] = [];
        if (usage.turns) {
            usageParts.push(`${usage.turns}t`);
            if (usage.input) usageParts.push(`↑${formatTokens(usage.input)}`);
            if (usage.cost) usageParts.push(`$${usage.cost.toFixed(2)}`);
        }
        const usageStr = usageParts.length > 0 ? usageParts.join(" ") : "";

        // Current activity
        let detail = this.getAgentDetail(agent);

        // Build the row
        const prefix = isSelected ? " ▸ " : "   ";
        const statusColor = this.statusColor(agent.status);
        const nameStr = `${icon} ${agent.name} (${role})`;

        // Calculate available space for detail
        const fixedLen = nameStr.length + (usageStr ? usageStr.length + 2 : 0) + 3; // padding
        const maxDetail = Math.max(contentWidth - fixedLen, 10);
        if (detail.length > maxDetail) {
            detail = detail.slice(0, maxDetail - 1) + "…";
        }

        let row = prefix;
        row += theme.fg(statusColor, nameStr);
        if (usageStr) row += "  " + theme.fg("dim", usageStr);
        if (detail) row += "  " + theme.fg("muted", detail);

        if (isSelected) {
            row = theme.bg("selectedBg", row);
        }

        return row;
    }

    // ─── Detail View ────────────────────────────────────────────────

    private renderDetail(width: number): string[] {
        const { theme } = this;
        const state = getSwarmState();
        if (!state || !this.detailAgent) return this.renderEmpty(width);

        const agent = state.agents.get(this.detailAgent);
        if (!agent) return this.renderEmpty(width);

        const allLines: string[] = [];

        // Header
        const icon = statusIcon(agent.status);
        const usage = getAgentUsage(agent.name);
        let usageStr = "";
        if (usage.turns) {
            const parts: string[] = [`${usage.turns}t`];
            if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
            if (usage.cost) parts.push(`$${usage.cost.toFixed(2)}`);
            usageStr = parts.join(" ");
        }

        const statusColor = this.statusColor(agent.status);
        allLines.push(
            " " + theme.fg("dim", "←") + " " +
            theme.bold(theme.fg(statusColor, `${icon} ${agent.name}`)) +
            theme.fg("muted", ` (${agent.role}, ${agent.swarm})`) +
            theme.fg("dim", ` — ${agent.status}`) +
            (usageStr ? "  " + theme.fg("dim", usageStr) : "")
        );

        // Separator
        allLines.push(theme.fg("border", " " + "─".repeat(Math.max(width - 2, 20))));

        // Status details (done summary, blocker)
        if (agent.doneSummary) {
            allLines.push(theme.fg("success", `  ✓ ${agent.doneSummary}`));
        }
        if (agent.blockerDescription) {
            allLines.push(theme.fg("warning", `  ⚠ ${agent.blockerDescription}`));
        }

        // Progress info
        if (agent.progressPhase || agent.progressPercent != null || agent.progressDetail) {
            const parts: string[] = [];
            if (agent.progressPhase) parts.push(agent.progressPhase);
            if (agent.progressPercent != null) parts.push(`${agent.progressPercent}%`);
            if (agent.progressDetail) parts.push(agent.progressDetail);
            allLines.push(theme.fg("accent", `  ⟳ ${parts.join(" — ")}`));
        }

        // Task
        if (agent.task) {
            allLines.push("");
            allLines.push(theme.bold(theme.fg("text", "  Task:")));
            const taskLines = this.wrapText(agent.task, width - 4);
            for (const line of taskLines) {
                allLines.push("  " + theme.fg("muted", line));
            }
        }

        // Activity feed
        allLines.push("");
        allLines.push(theme.bold(theme.fg("text", "  Activity:")));

        const activity = getAgentActivity(agent.name);
        if (activity.length === 0) {
            allLines.push(theme.fg("dim", "  (no activity recorded yet)"));
        } else {
            const themeFg = (color: string, text: string) => theme.fg(color as any, text);
            for (const ev of activity) {
                const age = formatAge(ev.timestamp).padStart(4);
                const icon = eventIcon(ev.type);

                // Use formatToolCall for tool events when we have structured data
                let line: string;
                if (ev.type === "tool_start" && ev.toolName) {
                    const formatted = formatToolCall(ev.toolName, ev.toolArgs || {}, themeFg);
                    line = `  ${theme.fg("dim", age)} ${icon} ${formatted}`;
                } else if (ev.type === "tool_end") {
                    const color = ev.isError ? "error" : "success";
                    line = `  ${theme.fg("dim", age)} ${theme.fg(color, ev.summary)}`;
                } else {
                    // Truncate long messages for the feed
                    let summary = ev.summary;
                    const maxLen = width - 14;
                    if (summary.length > maxLen) {
                        summary = summary.slice(0, maxLen - 1) + "…";
                    }
                    const color = ev.type === "thinking" ? "dim" : "muted";
                    line = `  ${theme.fg("dim", age)} ${icon} ${theme.fg(color, summary)}`;
                }
                allLines.push(line);
            }
        }

        // Usage summary at bottom
        if (usage.turns) {
            allLines.push("");
            allLines.push(theme.fg("border", " " + "─".repeat(Math.max(width - 2, 20))));
            allLines.push("  " + theme.fg("dim", formatUsageStats(usage)));
        }

        // Apply scroll offset — show a window of content
        const footerLines = [
            theme.fg("border", " " + "─".repeat(Math.max(width - 2, 20))),
            theme.fg("dim", "  ↑↓") + theme.fg("muted", " scroll") +
            theme.fg("dim", "  Esc") + theme.fg("muted", " back to list"),
        ];

        // Clamp scroll offset and track max for input handler
        const maxScroll = Math.max(0, allLines.length - 1);
        this.lastMaxScroll = maxScroll;
        if (this.scrollOffset > maxScroll) this.scrollOffset = maxScroll;
        if (this.scrollOffset < 0) this.scrollOffset = 0;

        const visibleLines = allLines.slice(this.scrollOffset);

        // Scroll indicator
        if (this.scrollOffset > 0) {
            visibleLines.unshift(theme.fg("dim", `  ↑ ${this.scrollOffset} more line${this.scrollOffset === 1 ? "" : "s"} above`));
        }

        return [...visibleLines, ...footerLines];
    }

    // ─── Input Handling ─────────────────────────────────────────────

    handleInput(data: string): void {
        switch (this.viewMode) {
            case "list":
                this.handleListInput(data);
                break;
            case "detail":
                this.handleDetailInput(data);
                break;
        }
    }

    private handleListInput(data: string): void {
        if (matchesKey(data, Key.up)) {
            if (this.selectedIndex > 0) {
                this.selectedIndex--;
                this.tui.requestRender();
            }
        } else if (matchesKey(data, Key.down)) {
            if (this.selectedIndex < this.cachedAgents.length - 1) {
                this.selectedIndex++;
                this.tui.requestRender();
            }
        } else if (matchesKey(data, Key.enter)) {
            if (this.cachedAgents.length > 0) {
                const agent = this.cachedAgents[this.selectedIndex];
                if (agent) {
                    this.viewMode = "detail";
                    this.detailAgent = agent.name;
                    this.scrollOffset = 0;
                    this.tui.requestRender();
                }
            }
        } else if (matchesKey(data, Key.escape) || data === "q") {
            this.close();
        }
    }

    private handleDetailInput(data: string): void {
        if (matchesKey(data, Key.up)) {
            if (this.scrollOffset > 0) {
                this.scrollOffset--;
                this.tui.requestRender();
            }
        } else if (matchesKey(data, Key.down)) {
            if (this.scrollOffset < this.lastMaxScroll) {
                this.scrollOffset++;
                this.tui.requestRender();
            }
        } else if (matchesKey(data, Key.escape)) {
            // Back to list view
            this.viewMode = "list";
            this.detailAgent = null;
            this.scrollOffset = 0;
            this.tui.requestRender();
        } else if (data === "q") {
            this.close();
        }
    }

    // ─── Helpers ────────────────────────────────────────────────────

    private refreshAgentList(): void {
        const state = getSwarmState();
        if (!state) {
            this.cachedAgents = [];
            return;
        }
        // Sort: running first, then starting, blocked, done, crashed, disconnected
        const order: Record<AgentStatus, number> = {
            running: 0,
            starting: 1,
            blocked: 2,
            done: 3,
            crashed: 4,
            disconnected: 5,
        };
        this.cachedAgents = Array.from(state.agents.values())
            .sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || a.name.localeCompare(b.name));

        // Clamp selectedIndex
        if (this.selectedIndex >= this.cachedAgents.length) {
            this.selectedIndex = Math.max(0, this.cachedAgents.length - 1);
        }
    }

    private getAgentDetail(agent: AgentInfo): string {
        if (agent.status === "done" && agent.doneSummary) {
            return agent.doneSummary;
        }
        if (agent.status === "blocked" && agent.blockerDescription) {
            return agent.blockerDescription;
        }
        if (agent.progressDetail) {
            return agent.progressDetail;
        }
        if (agent.progressPhase) {
            const parts: string[] = [agent.progressPhase];
            if (agent.progressPercent != null) parts.push(`${agent.progressPercent}%`);
            return parts.join(" — ");
        }
        // Last activity event
        const activity = getAgentActivity(agent.name);
        if (activity.length > 0) {
            return activity[activity.length - 1].summary;
        }
        return agent.status;
    }

    private statusColor(status: AgentStatus): string {
        switch (status) {
            case "running": return "accent";
            case "starting": return "muted";
            case "done": return "success";
            case "blocked": return "warning";
            case "crashed": return "error";
            case "disconnected": return "error";
            default: return "text";
        }
    }

    private wrapText(text: string, maxWidth: number): string[] {
        if (maxWidth <= 0) return [text];
        const words = text.split(/\s+/);
        const lines: string[] = [];
        let current = "";
        for (const word of words) {
            if (current.length + word.length + 1 > maxWidth && current.length > 0) {
                lines.push(current);
                current = word;
            } else {
                current = current ? current + " " + word : word;
            }
        }
        if (current) lines.push(current);
        // Cap at 5 lines for task display
        if (lines.length > 5) {
            return [...lines.slice(0, 4), lines[4].slice(0, maxWidth - 1) + "…"];
        }
        return lines;
    }

    private startRefresh(): void {
        if (this.refreshTimer) return;
        this.refreshTimer = setInterval(() => {
            this.tui.requestRender();
        }, 1500);
    }

    private stopRefresh(): void {
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = null;
        }
    }

    private close(): void {
        this.stopRefresh();
        this.done(undefined as unknown as void);
    }
}

// ─── Overlay Opener ─────────────────────────────────────────────────

/** Structural type for the extension context needed by the overlay. */
interface OverlayContext {
    hasUI: boolean;
    ui: {
        custom<T>(
            factory: (tui: TUI, theme: DashboardOptions["theme"], keybindings: unknown, done: (result: T) => void) => Component,
            options: { overlay: boolean; overlayOptions: { anchor: string; width: string; maxHeight: string } },
        ): Promise<T>;
    };
}

/**
 * Open the dashboard overlay.
 * @param ctx Extension context with UI access
 * @param focusAgent Optional agent name to pre-focus on (for /hive <name>)
 */
export function openDashboardOverlay(ctx: OverlayContext, focusAgent?: string): void {
    if (!ctx.hasUI) return;

    ctx.ui.custom(
        (tui: TUI, theme: DashboardOptions["theme"], _keybindings: unknown, done: (result: void) => void) => {
            return new DashboardOverlay({ tui, theme, done, focusAgent });
        },
        {
            overlay: true,
            overlayOptions: {
                anchor: "center",
                width: "80%",
                maxHeight: "80%",
            },
        },
    );
}
