/**
 * Display Formatting Utilities
 *
 * Pure functions for formatting tool calls, usage stats, and agent output.
 * Shared formatting utilities for swarm UI.
 */

import * as os from "node:os";
import type { AgentStatus } from "../core/state.js";

// ─── Status Icons ────────────────────────────────────────────────────

/** Canonical status icon for agent status display. */
export function statusIcon(status: AgentStatus): string {
    switch (status) {
        case "starting": return "◌";
        case "running": return "⏳";
        case "done": return "✓";
        case "blocked": return "⚠";
        case "disconnected": return "✗";
        case "crashed": return "💀";
        default: return "?";
    }
}

/** Icon for activity event types. */
export function eventIcon(type: "tool_start" | "tool_end" | "message" | "thinking"): string {
    switch (type) {
        case "tool_start": return "▸";
        case "tool_end": return "▪";
        case "message": return "💬";
        case "thinking": return "~";
        default: return " ";
    }
}

/** Format a timestamp as a relative age string (e.g. "3s ago", "2m ago"). */
export function formatAge(timestamp: number): string {
    const secs = Math.floor((Date.now() - timestamp) / 1000);
    if (secs < 60) return `${secs}s ago`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    return `${Math.floor(mins / 60)}h ago`;
}

// ─── Path Utilities ──────────────────────────────────────────────────

/** Replace home directory with ~ and truncate deep paths for display. */
export function shortenPath(p: string): string {
    const home = os.homedir();
    if (p.startsWith(home)) {
        p = "~" + p.slice(home.length);
    }
    // Truncate long paths to last 2 segments
    if (p.length > 50) {
        const parts = p.split("/");
        if (parts.length > 2) {
            p = "…/" + parts.slice(-2).join("/");
        }
    }
    return p;
}

// ─── Token Formatting ────────────────────────────────────────────────

export function formatTokens(count: number): string {
    if (count < 1000) return count.toString();
    if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
    if (count < 1000000) {
        const k = Math.round(count / 1000);
        return k >= 1000 ? `${(count / 1000000).toFixed(1)}M` : `${k}k`;
    }
    return `${(count / 1000000).toFixed(1)}M`;
}

// ─── Model Names ─────────────────────────────────────────────────────

/**
 * Shorten model names for compact display.
 * Strips "claude-" prefix and date suffix (YYYYMMDD).
 *
 * Examples:
 * - claude-haiku-4-5-20250514 → haiku-4-5
 * - claude-sonnet-4-5-20250514 → sonnet-4-5
 * - claude-opus-4-5 → opus-4-5
 * - unknown-model → unknown-model
 */
export function shortModelName(model: string | undefined): string | undefined {
    if (!model) return undefined;

    // Strip leading "claude-"
    let short = model.startsWith("claude-") ? model.slice(7) : model;

    // Strip trailing date suffix (8 digits)
    short = short.replace(/-\d{8}$/, "");

    return short;
}

// ─── Usage Stats ─────────────────────────────────────────────────────

export interface UsageStats {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    contextTokens?: number;
    turns?: number;
}

/**
 * Format usage stats into a compact display string.
 * e.g. "3 turns ↑12.5k ↓1.2k R8.3k W2.1k $0.0342 ctx:15.8k claude-sonnet-4-5-20250514"
 */
export function formatUsageStats(usage: UsageStats, model?: string): string {
    const parts: string[] = [];
    if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
    if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
    if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
    if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
    if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
    if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
    if (usage.contextTokens && usage.contextTokens > 0) {
        parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
    }
    if (model) parts.push(model);
    return parts.join(" ");
}


