/**
 * Agent Activity Tracker
 *
 * Captures agent stdout (JSON mode events) and stores activity
 * per agent. Provides a queryable activity feed and per-agent
 * usage tracking (tokens, cost, turns).
 */

import { type UsageStats } from "./format.js";
import { shortenPath } from "./format.js";

export interface ActivityEvent {
    timestamp: number;
    type: "tool_start" | "tool_end" | "message" | "thinking";
    summary: string;
    detail?: string;
    // Structured fields (populated when available)
    toolName?: string;
    toolArgs?: Record<string, unknown>;
    toolResult?: string;
    isError?: boolean;
    messageText?: string;
    tokens?: { input: number; output: number };
}

// Per-agent activity log (no cap — agent sessions are finite)
const agentActivity = new Map<string, ActivityEvent[]>();

// Per-agent usage accumulation
const agentUsage = new Map<string, UsageStats>();

function emptyUsage(): UsageStats {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

export function getAgentActivity(name: string): ActivityEvent[] {
    return agentActivity.get(name) || [];
}

export function getAllActivity(): Map<string, ActivityEvent[]> {
    return agentActivity;
}

export function getAgentUsage(name: string): UsageStats {
    return agentUsage.get(name) || emptyUsage();
}

export function getAggregateUsage(): UsageStats {
    const totals = emptyUsage();
    for (const usage of agentUsage.values()) {
        totals.input += usage.input;
        totals.output += usage.output;
        totals.cacheRead += usage.cacheRead;
        totals.cacheWrite += usage.cacheWrite;
        totals.cost += usage.cost;
        totals.turns = (totals.turns ?? 0) + (usage.turns ?? 0);
    }
    return totals;
}

export function clearActivity(name?: string): void {
    if (name) {
        agentActivity.delete(name);
        agentUsage.delete(name);
    } else {
        agentActivity.clear();
        agentUsage.clear();
    }
}

function pushEvent(name: string, event: ActivityEvent): void {
    if (!agentActivity.has(name)) {
        agentActivity.set(name, []);
    }
    agentActivity.get(name)!.push(event);
}

/**
 * Push a synthetic activity event for an agent.
 * Used for sub-agent relay events (register, done, blocked, nudge, disconnect)
 * where we don't have stdout to parse but want activity in the feed.
 */
export function pushSyntheticEvent(name: string, type: ActivityEvent["type"], summary: string): void {
    pushEvent(name, {
        timestamp: Date.now(),
        type,
        summary,
    });
}

/**
 * Parse a JSON-mode stdout line from an agent process.
 * Extracts tool calls, messages, and thinking events.
 */
function parseJsonEvent(agentName: string, line: string): void {
    let event: any;
    try {
        event = JSON.parse(line);
    } catch {
        return; // Not valid JSON, skip
    }

    const now = Date.now();

    switch (event.type) {
        case "tool_execution_start": {
            const toolName = event.toolName || "unknown";
            const toolArgs = event.args as Record<string, unknown> | undefined;
            let summary = toolName;

            // Extract useful info from args
            if (toolName === "read" && toolArgs?.path) {
                summary = `read ${shortenPath(toolArgs.path as string)}`;
            } else if (toolName === "bash" && toolArgs?.command) {
                const cmd = toolArgs.command as string;
                summary = `bash ${cmd.length > 50 ? cmd.slice(0, 50) + "…" : cmd}`;
            } else if (toolName === "edit" && toolArgs?.path) {
                summary = `edit ${shortenPath(toolArgs.path as string)}`;
            } else if (toolName === "write" && toolArgs?.path) {
                summary = `write ${shortenPath(toolArgs.path as string)}`;
            } else if (toolName === "hive_notify") {
                summary = `hive_notify "${toolArgs?.reason || ""}"`;
            } else if (toolName === "hive_blocker") {
                summary = `hive_blocker "${toolArgs?.description || ""}"`;
            } else if (toolName === "hive_done") {
                summary = `hive_done "${toolArgs?.summary || ""}"`;
            } else if (toolName === "hive_progress") {
                const parts: string[] = [];
                if (toolArgs?.phase) parts.push(toolArgs.phase as string);
                if (toolArgs?.percent != null) parts.push(`${toolArgs.percent}%`);
                if (toolArgs?.detail) parts.push(toolArgs.detail as string);
                summary = `hive_progress ${parts.join(" — ") || ""}`;
            }

            pushEvent(agentName, {
                timestamp: now,
                type: "tool_start",
                summary,
                detail: JSON.stringify(toolArgs),
                toolName,
                toolArgs,
            });
            break;
        }

        case "tool_execution_end": {
            const toolName = event.toolName || "unknown";
            const isError = !!event.isError;
            const summary = isError ? `✗ ${toolName} failed` : `✓ ${toolName}`;
            const toolResult = event.result != null ? String(event.result) : undefined;

            pushEvent(agentName, {
                timestamp: now,
                type: "tool_end",
                summary,
                detail: isError ? JSON.stringify(event.result) : undefined,
                toolName,
                isError,
                toolResult: toolResult ? toolResult.slice(0, 1024) : undefined,
            });
            break;
        }

        case "message_end": {
            const msg = event.message;
            if (msg?.role === "assistant") {
                // Accumulate usage
                const usage = msg.usage;
                if (usage) {
                    if (!agentUsage.has(agentName)) {
                        agentUsage.set(agentName, emptyUsage());
                    }
                    const stats = agentUsage.get(agentName)!;
                    stats.input += usage.input || 0;
                    stats.output += usage.output || 0;
                    stats.cacheRead += usage.cacheRead || 0;
                    stats.cacheWrite += usage.cacheWrite || 0;
                    stats.cost += usage.cost?.total || 0;
                    stats.contextTokens = usage.totalTokens || 0;
                    stats.turns = (stats.turns ?? 0) + 1;
                }

                // Extract text/thinking from content
                if (msg.content) {
                    const tokens = usage
                        ? { input: usage.input || 0, output: usage.output || 0 }
                        : undefined;

                    for (const part of msg.content) {
                        if (part.type === "text" && part.text?.trim()) {
                            const text = part.text.trim();
                            const snippet = text.length > 80
                                ? text.slice(0, 80) + "…"
                                : text;
                            pushEvent(agentName, {
                                timestamp: now,
                                type: "message",
                                summary: snippet,
                                messageText: text,
                                tokens,
                            });
                            break; // Only first text part
                        }
                        if (part.type === "thinking" && part.thinking?.trim()) {
                            const text = part.thinking.trim();
                            const snippet = text.length > 80
                                ? text.slice(0, 80) + "…"
                                : text;
                            pushEvent(agentName, {
                                timestamp: now,
                                type: "thinking",
                                summary: snippet,
                                tokens,
                            });
                        }
                    }
                }
            }
            break;
        }
    }
}

/**
 * Attach a stdout parser to an agent's process.
 * Call this right after spawning the process.
 */
export function trackAgentOutput(agentName: string, stdout: NodeJS.ReadableStream): void {
    let buffer = "";

    stdout.on("data", (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || ""; // Keep incomplete line in buffer

        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed) {
                parseJsonEvent(agentName, trimmed);
            }
        }
    });

    // Flush remaining buffer on close
    stdout.on("close", () => {
        if (buffer.trim()) {
            parseJsonEvent(agentName, buffer.trim());
        }
    });
}


