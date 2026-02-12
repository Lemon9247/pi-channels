/**
 * Display Formatting Utilities
 *
 * Pure functions for formatting tool calls, usage stats, and agent output.
 * Ported from the subagent extension for shared use.
 */

import * as os from "node:os";
import type { Message } from "@mariozechner/pi-ai";
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

// ─── Tool Call Formatting ────────────────────────────────────────────

type ThemeFg = (color: string, text: string) => string;

/**
 * Format a tool call for display with context-aware rendering.
 * bash shows `$`, read shows `path:lines`, write shows line count, etc.
 */
export function formatToolCall(
    toolName: string,
    args: Record<string, unknown>,
    themeFg: ThemeFg,
): string {
    switch (toolName) {
        case "bash": {
            const command = (args.command as string) || "...";
            const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
            return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
        }
        case "read": {
            const rawPath = (args.file_path || args.path || "...") as string;
            const filePath = shortenPath(rawPath);
            const offset = args.offset as number | undefined;
            const limit = args.limit as number | undefined;
            let text = themeFg("accent", filePath);
            if (offset !== undefined || limit !== undefined) {
                const startLine = offset ?? 1;
                const endLine = limit !== undefined ? startLine + limit - 1 : "";
                text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
            }
            return themeFg("muted", "read ") + text;
        }
        case "write": {
            const rawPath = (args.file_path || args.path || "...") as string;
            const filePath = shortenPath(rawPath);
            const content = (args.content || "") as string;
            const lines = content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
            let text = themeFg("muted", "write ") + themeFg("accent", filePath);
            if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
            return text;
        }
        case "edit": {
            const rawPath = (args.file_path || args.path || "...") as string;
            return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
        }
        case "ls": {
            const rawPath = (args.path || ".") as string;
            return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
        }
        case "find": {
            const pattern = (args.pattern || "*") as string;
            const rawPath = (args.path || ".") as string;
            return (
                themeFg("muted", "find ") +
                themeFg("accent", pattern) +
                themeFg("dim", ` in ${shortenPath(rawPath)}`)
            );
        }
        case "grep": {
            const pattern = (args.pattern || "") as string;
            const rawPath = (args.path || ".") as string;
            return (
                themeFg("muted", "grep ") +
                themeFg("accent", `/${pattern}/`) +
                themeFg("dim", ` in ${shortenPath(rawPath)}`)
            );
        }
        default: {
            const argsStr = JSON.stringify(args);
            const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
            return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
        }
    }
}

// ─── Message Extraction ──────────────────────────────────────────────

/**
 * Get the final output text from a message array.
 *
 * Walks backward through messages to find the last assistant message,
 * then finds the last non-empty text part within it. This correctly
 * handles thinking models which put "\n\n" as the first text part
 * before the thinking block.
 */
export function getFinalOutput(messages: Message[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role === "assistant") {
            let lastText = "";
            for (const part of msg.content) {
                if (part.type === "text" && part.text.trim()) lastText = part.text;
            }
            if (lastText) return lastText;
        }
    }
    return "";
}

export type DisplayItem =
    | { type: "text"; text: string }
    | { type: "toolCall"; name: string; args: Record<string, unknown> };

/** Extract display items (text + tool calls) from a message array. */
export function getDisplayItems(messages: Message[]): DisplayItem[] {
    const items: DisplayItem[] = [];
    for (const msg of messages) {
        if (msg.role === "assistant") {
            for (const part of msg.content) {
                if (part.type === "text") items.push({ type: "text", text: part.text });
                else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
            }
        }
    }
    return items;
}
