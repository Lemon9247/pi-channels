/**
 * Agent Activity Tracker
 *
 * Captures agent stdout (JSON mode events) and stores recent
 * activity per agent. Provides a queryable activity feed.
 */

export interface ActivityEvent {
    timestamp: number;
    type: "tool_start" | "tool_end" | "message" | "thinking";
    summary: string;
    detail?: string;
}

const MAX_EVENTS_PER_AGENT = 30;

// Per-agent activity log
const agentActivity = new Map<string, ActivityEvent[]>();

export function getAgentActivity(name: string): ActivityEvent[] {
    return agentActivity.get(name) || [];
}

export function getAllActivity(): Map<string, ActivityEvent[]> {
    return agentActivity;
}

export function clearActivity(name?: string): void {
    if (name) {
        agentActivity.delete(name);
    } else {
        agentActivity.clear();
    }
}

function pushEvent(name: string, event: ActivityEvent): void {
    if (!agentActivity.has(name)) {
        agentActivity.set(name, []);
    }
    const events = agentActivity.get(name)!;
    events.push(event);
    if (events.length > MAX_EVENTS_PER_AGENT) {
        events.shift();
    }
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
            let summary = toolName;

            // Extract useful info from args
            if (toolName === "read" && event.args?.path) {
                summary = `read ${shortenPath(event.args.path)}`;
            } else if (toolName === "bash" && event.args?.command) {
                const cmd = event.args.command;
                summary = `bash ${cmd.length > 50 ? cmd.slice(0, 50) + "…" : cmd}`;
            } else if (toolName === "edit" && event.args?.path) {
                summary = `edit ${shortenPath(event.args.path)}`;
            } else if (toolName === "write" && event.args?.path) {
                summary = `write ${shortenPath(event.args.path)}`;
            } else if (toolName === "hive_notify") {
                summary = `hive_notify "${event.args?.reason || ""}"`;
            } else if (toolName === "hive_blocker") {
                summary = `hive_blocker "${event.args?.description || ""}"`;
            } else if (toolName === "hive_done") {
                summary = `hive_done "${event.args?.summary || ""}"`;
            } else if (toolName === "hive_progress") {
                const parts: string[] = [];
                if (event.args?.phase) parts.push(event.args.phase);
                if (event.args?.percent != null) parts.push(`${event.args.percent}%`);
                if (event.args?.detail) parts.push(event.args.detail);
                summary = `hive_progress ${parts.join(" — ") || ""}`;
            }

            pushEvent(agentName, {
                timestamp: now,
                type: "tool_start",
                summary,
                detail: JSON.stringify(event.args),
            });
            break;
        }

        case "tool_execution_end": {
            const toolName = event.toolName || "unknown";
            const isError = event.isError;
            const summary = isError ? `✗ ${toolName} failed` : `✓ ${toolName}`;

            pushEvent(agentName, {
                timestamp: now,
                type: "tool_end",
                summary,
                detail: isError ? JSON.stringify(event.result) : undefined,
            });
            break;
        }

        case "message_end": {
            // Extract a snippet of the assistant's response
            const msg = event.message;
            if (msg?.role === "assistant" && msg?.content) {
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
                        });
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

function shortenPath(p: string): string {
    // Replace home dir
    const home = process.env.HOME || "";
    if (home && p.startsWith(home)) {
        p = "~" + p.slice(home.length);
    }
    // If still long, show last 2 segments
    if (p.length > 50) {
        const parts = p.split("/");
        if (parts.length > 2) {
            p = "…/" + parts.slice(-2).join("/");
        }
    }
    return p;
}
