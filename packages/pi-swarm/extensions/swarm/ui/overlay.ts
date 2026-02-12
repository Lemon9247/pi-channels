/**
 * Interactive Dashboard Overlay
 *
 * Modal overlay for swarm observation and interaction.
 * Two view modes:
 *   - List: all agents with status, usage, current activity. Arrow key navigation.
 *   - Detail: single agent with raw output stream (thinking, messages, tool calls
 *     with full results). Scrollable. Press 'i' to send instructions.
 *
 * Reads from the same stores as the passive widget (activity.ts, state.ts).
 * Live-updates via a refresh timer while open.
 */

import type { TUI, Component, Focusable } from "@mariozechner/pi-tui";
import { matchesKey, Key, visibleWidth, truncateToWidth, CURSOR_MARKER, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import { getSwarmState, type AgentInfo } from "../core/state.js";
import { getAgentActivity, getAgentUsage, getAggregateUsage, type ActivityEvent } from "./activity.js";
import { formatTokens, formatUsageStats, statusIcon, formatAge } from "./format.js";
import { getIdentity } from "../core/identity.js";
import { inboxName, GENERAL_CHANNEL } from "../core/channels.js";

// ─── Types ──────────────────────────────────────────────────────────

type AgentStatus = "running" | "starting" | "done" | "blocked" | "crashed" | "disconnected";
type ViewMode = "list" | "detail";

interface Theme {
    fg: (color: string, text: string) => string;
    bg: (color: string, text: string) => string;
    bold: (text: string) => string;
}

interface DashboardOptions {
    tui: TUI;
    theme: Theme;
    done: (result: void) => void;
    focusAgent?: string;
}

// ─── Overlay Component ──────────────────────────────────────────────

export class DashboardOverlay implements Component, Focusable {
    private tui: TUI;
    private theme: Theme;
    private done: (result: void) => void;

    // Focusable — set by TUI when this component has focus
    focused = false;

    // View state
    private viewMode: ViewMode = "list";
    private selectedIndex = 0;
    private scrollOffset = 0;
    private autoScroll = true;
    private detailAgent: string | null = null;

    // Instruct input state
    private inputActive = false;
    private inputText = "";
    private inputCursor = 0;

    // Cached agent list for stable indexing
    private cachedAgents: AgentInfo[] = [];

    // Track rendered content height for scroll clamping
    private lastContentHeight = 0;

    // Live update timer
    private refreshTimer: ReturnType<typeof setInterval> | null = null;

    constructor(opts: DashboardOptions) {
        this.tui = opts.tui;
        this.theme = opts.theme;
        this.done = opts.done;

        this.refreshAgentList();

        if (opts.focusAgent) {
            const idx = this.cachedAgents.findIndex(a => a.name === opts.focusAgent);
            if (idx >= 0) {
                this.viewMode = "detail";
                this.detailAgent = opts.focusAgent;
                this.selectedIndex = idx;
                this.scrollOffset = 0;
            }
        }

        this.startRefresh();
    }

    dispose(): void {
        this.stopRefresh();
    }

    invalidate(): void {
        // No cached render state — we rebuild every frame
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
        const t = this.theme;
        const iw = width - 2;
        return [
            t.fg("border", `╭${"─".repeat(iw)}╮`),
            this.row(t.bold(t.fg("accent", " 🐝 Agent Dashboard")), width),
            this.row("", width),
            this.row(t.fg("muted", "  No active swarm."), width),
            this.row("", width),
            this.row("  " + t.fg("dim", "Esc") + t.fg("muted", " close"), width),
            t.fg("border", `╰${"─".repeat(iw)}╯`),
        ];
    }

    // ─── List View ──────────────────────────────────────────────────

    private renderList(width: number): string[] {
        const t = this.theme;
        const iw = width - 2;
        const lines: string[] = [];

        // Header
        const agents = this.cachedAgents;
        const doneCount = agents.filter(a => a.status === "done").length;
        const agg = getAggregateUsage();
        let header = ` 🐝 Agent Dashboard — ${doneCount}/${agents.length} complete`;
        if (agg.cost > 0) header += ` — $${agg.cost.toFixed(2)}`;
        lines.push(t.fg("border", `╭${"─".repeat(iw)}╮`));
        lines.push(this.row(t.bold(t.fg("accent", header)), width));
        lines.push(this.row(t.fg("border", " " + "─".repeat(iw - 2)), width));

        // Agent rows
        for (let i = 0; i < agents.length; i++) {
            const agent = agents[i];
            const isSelected = i === this.selectedIndex;
            lines.push(this.renderAgentRow(agent, width, isSelected));
        }

        // Footer
        lines.push(this.row(t.fg("border", " " + "─".repeat(iw - 2)), width));
        lines.push(this.row(
            "  " + t.fg("dim", "↑↓") + t.fg("muted", " navigate  ") +
            t.fg("dim", "⏎") + t.fg("muted", " detail  ") +
            t.fg("dim", "Esc/q") + t.fg("muted", " close"),
            width,
        ));
        lines.push(t.fg("border", `╰${"─".repeat(iw)}╯`));

        return lines;
    }

    private renderAgentRow(agent: AgentInfo, width: number, isSelected: boolean): string {
        const t = this.theme;
        const icon = statusIcon(agent.status);
        const role = agent.role === "coordinator" ? "co" : "ag";

        // Usage
        const usage = getAgentUsage(agent.name);
        const usageParts: string[] = [];
        if (usage.turns) {
            usageParts.push(`${usage.turns}t`);
            if (usage.input) usageParts.push(`↑${formatTokens(usage.input)}`);
            if (usage.cost) usageParts.push(`$${usage.cost.toFixed(2)}`);
        }
        const usageStr = usageParts.length > 0 ? usageParts.join(" ") : "";

        // Current activity summary
        let detail = this.getAgentSummary(agent);

        // Build row
        const prefix = isSelected ? " ▸ " : "   ";
        const statusColor = this.statusColor(agent.status);
        const nameStr = `${icon} ${agent.name} (${role})`;

        // Calculate available space for detail
        const fixedWidth = visibleWidth(prefix) + visibleWidth(nameStr) + (usageStr ? visibleWidth(usageStr) + 4 : 2);
        const maxDetail = Math.max(width - fixedWidth - 4, 10);
        if (visibleWidth(detail) > maxDetail) {
            detail = truncateToWidth(detail, maxDetail);
        }

        let row = prefix + t.fg(statusColor, nameStr);
        if (usageStr) row += "  " + t.fg("dim", usageStr);
        if (detail) row += "  " + t.fg("muted", detail);

        if (isSelected) {
            row = t.bg("selectedBg", row);
        }

        return this.row(row, width);
    }

    // ─── Detail View ────────────────────────────────────────────────

    private renderDetail(width: number): string[] {
        const t = this.theme;
        const iw = width - 2;
        const state = getSwarmState();
        if (!state || !this.detailAgent) return this.renderEmpty(width);

        const agent = state.agents.get(this.detailAgent);
        if (!agent) return this.renderEmpty(width);

        // Build all content lines (before scroll windowing)
        const contentLines: string[] = [];

        // Header
        const icon = statusIcon(agent.status);
        const usage = getAgentUsage(agent.name);
        const statusColor = this.statusColor(agent.status);
        let headerText = " " + t.fg("dim", "←") + " " +
            t.bold(t.fg(statusColor, `${icon} ${agent.name}`)) +
            t.fg("muted", ` (${agent.role}, ${agent.swarm})`) +
            t.fg("dim", ` — ${agent.status}`);
        if (usage.turns) {
            const parts = [`${usage.turns}t`];
            if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
            if (usage.cost) parts.push(`$${usage.cost.toFixed(2)}`);
            headerText += "  " + t.fg("dim", parts.join(" "));
        }
        contentLines.push(headerText);
        contentLines.push(t.fg("border", " " + "─".repeat(Math.max(iw - 2, 10))));

        // Status details
        if (agent.doneSummary) {
            contentLines.push(t.fg("success", `  ✓ ${agent.doneSummary}`));
        }
        if (agent.blockerDescription) {
            contentLines.push(t.fg("warning", `  ⚠ ${agent.blockerDescription}`));
        }
        if (agent.progressPhase || agent.progressPercent != null || agent.progressDetail) {
            const parts: string[] = [];
            if (agent.progressPhase) parts.push(agent.progressPhase);
            if (agent.progressPercent != null) parts.push(`${agent.progressPercent}%`);
            if (agent.progressDetail) parts.push(agent.progressDetail);
            contentLines.push(t.fg("accent", `  ⟳ ${parts.join(" — ")}`));
        }

        // Task
        if (agent.task) {
            contentLines.push("");
            contentLines.push(t.bold(t.fg("text", "  Task:")));
            const taskLines = this.wrapText(agent.task, iw - 6);
            for (const line of taskLines.slice(0, 5)) {
                contentLines.push("  " + t.fg("muted", line));
            }
            if (taskLines.length > 5) {
                contentLines.push("  " + t.fg("dim", `… (${taskLines.length - 5} more lines)`));
            }
        }

        // Activity stream
        contentLines.push("");
        contentLines.push(t.bold(t.fg("text", "  Activity:")));
        const activity = getAgentActivity(agent.name);
        const contentWidth = iw - 4; // padding inside borders

        if (activity.length === 0) {
            contentLines.push(t.fg("dim", "  (waiting for activity...)"));
        } else {
            for (const ev of activity) {
                const age = formatAge(ev.timestamp).padStart(4);
                const ageStr = t.fg("dim", age) + " ";

                switch (ev.type) {
                    case "thinking": {
                        const text = ev.thinkingText || ev.summary;
                        const prefix = "💭 ";
                        const firstLineWidth = contentWidth - visibleWidth(ageStr) - visibleWidth(prefix);
                        const wrappedLines = this.wrapText(text, firstLineWidth);
                        if (wrappedLines.length > 0) {
                            contentLines.push("  " + ageStr + t.fg("dim", prefix + wrappedLines[0]));
                            const indentWidth = visibleWidth("  " + ageStr + prefix);
                            const indent = " ".repeat(indentWidth);
                            for (let i = 1; i < Math.min(wrappedLines.length, 6); i++) {
                                contentLines.push(t.fg("dim", indent + wrappedLines[i]));
                            }
                            if (wrappedLines.length > 6) {
                                contentLines.push(t.fg("dim", indent + `… (${wrappedLines.length - 6} more lines)`));
                            }
                        }
                        break;
                    }

                    case "message": {
                        const text = ev.messageText || ev.summary;
                        const prefix = "💬 ";
                        const firstLineWidth = contentWidth - visibleWidth(ageStr) - visibleWidth(prefix);
                        const wrappedLines = this.wrapText(text, firstLineWidth);
                        if (wrappedLines.length > 0) {
                            contentLines.push("  " + ageStr + t.fg("text", prefix + wrappedLines[0]));
                            const indentWidth = visibleWidth("  " + ageStr + prefix);
                            const indent = " ".repeat(indentWidth);
                            for (let i = 1; i < Math.min(wrappedLines.length, 10); i++) {
                                contentLines.push(t.fg("text", indent + wrappedLines[i]));
                            }
                            if (wrappedLines.length > 10) {
                                contentLines.push(t.fg("dim", indent + `… (${wrappedLines.length - 10} more lines)`));
                            }
                        }
                        break;
                    }

                    case "tool_start": {
                        let formatted: string;
                        if (ev.toolName) {
                            formatted = this.formatToolStart(ev.toolName, ev.toolArgs || {});
                        } else {
                            formatted = ev.summary;
                        }
                        contentLines.push("  " + ageStr + t.fg("accent", "▶ " + formatted));
                        break;
                    }

                    case "tool_end": {
                        const color = ev.isError ? "error" : "success";
                        const marker = ev.isError ? "✗" : "✓";
                        const resultIndent = "  " + " ".repeat(visibleWidth(ageStr));

                        if (ev.toolResult) {
                            // Show tool result (word-wrapped, capped)
                            const resultText = ev.toolResult;
                            const maxResultWidth = contentWidth - visibleWidth(resultIndent) - 2;
                            const resultLines = this.wrapText(resultText, maxResultWidth);
                            const maxLines = ev.isError ? 10 : 4;

                            if (resultLines.length <= maxLines) {
                                for (const line of resultLines) {
                                    contentLines.push(resultIndent + t.fg(color, `  ${line}`));
                                }
                            } else {
                                for (let i = 0; i < maxLines; i++) {
                                    contentLines.push(resultIndent + t.fg(color, `  ${resultLines[i]}`));
                                }
                                contentLines.push(resultIndent + t.fg("dim", `  … (${resultLines.length - maxLines} more lines)`));
                            }
                        } else {
                            contentLines.push(resultIndent + t.fg(color, `${marker} ${ev.toolName || ""}`));
                        }
                        break;
                    }
                }
            }
        }

        // Usage summary at bottom
        if (usage.turns) {
            contentLines.push("");
            contentLines.push(t.fg("border", " " + "─".repeat(Math.max(iw - 2, 10))));
            contentLines.push("  " + t.fg("dim", formatUsageStats(usage)));
        }

        // Store content height for scroll clamping
        this.lastContentHeight = contentLines.length;

        // Now assemble the final output with borders, scroll window, and footer

        const lines: string[] = [];
        lines.push(t.fg("border", `╭${"─".repeat(iw)}╮`));

        // Calculate visible area (reserve space for footer)
        const footerHeight = this.inputActive ? 4 : 3; // border + hints + (input bar + border)
        const maxVisible = 30; // reasonable max height
        const visibleHeight = Math.min(contentLines.length, maxVisible);

        // Auto-scroll: if we were at the bottom, stay at the bottom
        const maxScroll = Math.max(0, contentLines.length - visibleHeight);
        if (this.autoScroll) {
            this.scrollOffset = maxScroll;
        }
        // Clamp scroll
        if (this.scrollOffset > maxScroll) this.scrollOffset = maxScroll;
        if (this.scrollOffset < 0) this.scrollOffset = 0;

        // Scroll indicator
        if (this.scrollOffset > 0) {
            lines.push(this.row(t.fg("dim", `  ↑ ${this.scrollOffset} more line${this.scrollOffset === 1 ? "" : "s"} above`), width));
        }

        // Visible content window
        const visible = contentLines.slice(this.scrollOffset, this.scrollOffset + visibleHeight);
        for (const line of visible) {
            lines.push(this.row(line, width));
        }

        if (this.scrollOffset < maxScroll) {
            const below = maxScroll - this.scrollOffset;
            lines.push(this.row(t.fg("dim", `  ↓ ${below} more line${below === 1 ? "" : "s"} below`), width));
        }

        // Footer separator
        lines.push(this.row(t.fg("border", " " + "─".repeat(Math.max(iw - 2, 10))), width));

        // Keybind hints
        let hints = "  " + t.fg("dim", "↑↓") + t.fg("muted", " scroll  ");
        if (!this.inputActive) {
            hints += t.fg("dim", "i") + t.fg("muted", " instruct  ");
        }
        hints += t.fg("dim", "Esc") + t.fg("muted", " back  ");
        hints += t.fg("dim", "q") + t.fg("muted", " close");
        lines.push(this.row(hints, width));

        // Instruct input bar
        if (this.inputActive) {
            lines.push(this.row(t.fg("border", " " + "─".repeat(Math.max(iw - 2, 10))), width));
            const prompt = t.fg("accent", " ▸ ");
            const beforeCursor = this.inputText.slice(0, this.inputCursor);
            const cursorChar = this.inputCursor < this.inputText.length ? this.inputText[this.inputCursor]! : " ";
            const afterCursor = this.inputText.slice(this.inputCursor + 1);
            const marker = this.focused ? CURSOR_MARKER : "";
            const inputLine = prompt + beforeCursor + marker + `\x1b[7m${cursorChar}\x1b[27m` + afterCursor;
            lines.push(this.row(inputLine, width));
        }

        // Bottom border
        lines.push(t.fg("border", `╰${"─".repeat(iw)}╯`));

        return lines;
    }

    // ─── Input Handling ─────────────────────────────────────────────

    handleInput(data: string): void {
        if (this.inputActive) {
            this.handleInputMode(data);
            return;
        }

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
                    this.autoScroll = true;
                    this.tui.requestRender();
                }
            }
        } else if (matchesKey(data, Key.escape) || data === "q") {
            this.close();
        }
    }

    private handleDetailInput(data: string): void {
        if (matchesKey(data, Key.up)) {
            this.autoScroll = false;
            if (this.scrollOffset > 0) {
                this.scrollOffset--;
                this.tui.requestRender();
            }
        } else if (matchesKey(data, Key.down)) {
            const maxScroll = Math.max(0, this.lastContentHeight - 30);
            if (this.scrollOffset < maxScroll) {
                this.scrollOffset++;
                this.tui.requestRender();
            }
            // Re-enable auto-scroll if we're at the bottom
            if (this.scrollOffset >= maxScroll) {
                this.autoScroll = true;
            }
        } else if (data === "i") {
            // Activate instruct input
            this.inputActive = true;
            this.inputText = "";
            this.inputCursor = 0;
            this.tui.requestRender();
        } else if (matchesKey(data, Key.escape)) {
            // Back to list
            this.viewMode = "list";
            this.detailAgent = null;
            this.scrollOffset = 0;
            this.autoScroll = true;
            this.tui.requestRender();
        } else if (data === "q") {
            this.close();
        }
    }

    private handleInputMode(data: string): void {
        if (matchesKey(data, Key.escape)) {
            // Cancel input
            this.inputActive = false;
            this.inputText = "";
            this.inputCursor = 0;
            this.tui.requestRender();
        } else if (matchesKey(data, Key.enter)) {
            // Send instruction
            if (this.inputText.trim() && this.detailAgent) {
                this.sendInstruction(this.detailAgent, this.inputText.trim());
            }
            this.inputActive = false;
            this.inputText = "";
            this.inputCursor = 0;
            this.tui.requestRender();
        } else if (matchesKey(data, Key.backspace)) {
            if (this.inputCursor > 0) {
                this.inputText = this.inputText.slice(0, this.inputCursor - 1) + this.inputText.slice(this.inputCursor);
                this.inputCursor--;
                this.tui.requestRender();
            }
        } else if (matchesKey(data, Key.left)) {
            if (this.inputCursor > 0) {
                this.inputCursor--;
                this.tui.requestRender();
            }
        } else if (matchesKey(data, Key.right)) {
            if (this.inputCursor < this.inputText.length) {
                this.inputCursor++;
                this.tui.requestRender();
            }
        } else if (matchesKey(data, Key.home)) {
            this.inputCursor = 0;
            this.tui.requestRender();
        } else if (matchesKey(data, Key.end)) {
            this.inputCursor = this.inputText.length;
            this.tui.requestRender();
        } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
            // Printable character
            this.inputText = this.inputText.slice(0, this.inputCursor) + data + this.inputText.slice(this.inputCursor);
            this.inputCursor++;
            this.tui.requestRender();
        }
    }

    // ─── Instruct ───────────────────────────────────────────────────

    private sendInstruction(agentName: string, instruction: string): void {
        const state = getSwarmState();
        if (!state) return;

        const identity = getIdentity();
        const msg = {
            msg: instruction,
            data: {
                type: "instruct",
                from: identity.name,
                instruction,
                to: agentName,
            },
        };

        // Try agent inbox first
        const targetInbox = inboxName(agentName);
        const inboxClient = state.queenClients.get(targetInbox);
        if (inboxClient?.connected) {
            try {
                inboxClient.send(msg);
                return;
            } catch { /* fall through */ }
        }

        // Fallback to general
        const generalClient = state.queenClients.get(GENERAL_CHANNEL);
        if (generalClient?.connected) {
            try {
                generalClient.send(msg);
            } catch { /* ignore */ }
        }
    }

    // ─── Helpers ────────────────────────────────────────────────────

    /** Pad a content string into a bordered row */
    private row(content: string, width: number): string {
        const t = this.theme;
        const iw = width - 2;
        const vw = visibleWidth(content);
        const padding = Math.max(0, iw - vw);
        return t.fg("border", "│") + content + " ".repeat(padding) + t.fg("border", "│");
    }

    private refreshAgentList(): void {
        const state = getSwarmState();
        if (!state) {
            this.cachedAgents = [];
            return;
        }
        const order: Record<string, number> = {
            running: 0, starting: 1, blocked: 2, done: 3, crashed: 4, disconnected: 5,
        };
        this.cachedAgents = Array.from(state.agents.values())
            .sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || a.name.localeCompare(b.name));

        if (this.selectedIndex >= this.cachedAgents.length) {
            this.selectedIndex = Math.max(0, this.cachedAgents.length - 1);
        }
    }

    private getAgentSummary(agent: AgentInfo): string {
        if (agent.status === "done" && agent.doneSummary) return agent.doneSummary;
        if (agent.status === "blocked" && agent.blockerDescription) return agent.blockerDescription;
        if (agent.progressDetail) return agent.progressDetail;
        if (agent.progressPhase) {
            const parts: string[] = [agent.progressPhase];
            if (agent.progressPercent != null) parts.push(`${agent.progressPercent}%`);
            return parts.join(" — ");
        }
        const activity = getAgentActivity(agent.name);
        if (activity.length > 0) return activity[activity.length - 1].summary;
        return agent.status;
    }

    private statusColor(status: string): string {
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

    private formatToolStart(name: string, args: Record<string, unknown>): string {
        switch (name) {
            case "bash": {
                const cmd = (args.command as string) || "";
                return `$ ${cmd.length > 80 ? cmd.slice(0, 80) + "…" : cmd}`;
            }
            case "read": {
                const path = (args.path as string) || "";
                let desc = `read ${path}`;
                if (args.offset) desc += `:${args.offset}`;
                if (args.limit) desc += `+${args.limit}`;
                return desc;
            }
            case "edit":
                return `edit ${(args.path as string) || ""}`;
            case "write":
                return `write ${(args.path as string) || ""}`;
            case "hive_notify":
                return `hive_notify "${(args.reason as string) || ""}"`;
            case "hive_blocker":
                return `hive_blocker "${(args.description as string) || ""}"`;
            case "hive_done":
                return `hive_done "${(args.summary as string) || ""}"`;
            case "hive_progress": {
                const parts: string[] = [];
                if (args.phase) parts.push(args.phase as string);
                if (args.percent != null) parts.push(`${args.percent}%`);
                if (args.detail) parts.push(args.detail as string);
                return `hive_progress ${parts.join(" — ")}`;
            }
            default:
                return name;
        }
    }

    private wrapText(text: string, maxWidth: number): string[] {
        if (maxWidth <= 0) return [text];
        const lines: string[] = [];
        // Split on newlines first, then word-wrap each line
        for (const rawLine of text.split("\n")) {
            if (rawLine.length === 0) {
                lines.push("");
                continue;
            }
            const words = rawLine.split(/(\s+)/);
            let current = "";
            for (const word of words) {
                if (current.length + word.length > maxWidth && current.length > 0) {
                    lines.push(current);
                    current = word.trimStart();
                } else {
                    current += word;
                }
            }
            if (current) lines.push(current);
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
            factory: (tui: TUI, theme: Theme, keybindings: unknown, done: (result: T) => void) => Component,
            options: { overlay: boolean; overlayOptions: { anchor: string; width: string; maxHeight: string } },
        ): Promise<T>;
    };
}

/**
 * Open the dashboard overlay.
 */
export function openDashboardOverlay(ctx: OverlayContext, focusAgent?: string): void {
    if (!ctx.hasUI) return;

    ctx.ui.custom(
        (tui: TUI, theme: Theme, _keybindings: unknown, done: (result: void) => void) => {
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
