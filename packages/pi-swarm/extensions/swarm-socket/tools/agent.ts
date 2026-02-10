/**
 * Agent Tools
 *
 * Tools available to agents inside a swarm:
 * - hive_progress: Report progress to the dashboard
 * - hive_notify: Nudge teammates to check the hive-mind
 * - hive_blocker: Signal that you're blocked
 * - hive_done: Signal task completion
 *
 * Each tool sends a Message to the appropriate channel(s).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import type { ChannelClient, Message } from "../../../../agent-channels/dist/index.js";
import { getParentClients } from "../core/state.js";
import { getIdentity } from "../core/identity.js";
import { GENERAL_CHANNEL, QUEEN_INBOX, inboxName } from "../core/channels.js";

/**
 * Get a connected ChannelClient by channel name from parent clients.
 * Returns null if not connected or channel not found.
 */
function getClient(channelName: string): ChannelClient | null {
    const clients = getParentClients();
    if (!clients) return null;
    const client = clients.get(channelName);
    if (!client || !client.connected) return null;
    return client;
}

/**
 * Send a message to a channel. Returns true if sent, false if not connected.
 */
function sendToChannel(channelName: string, msg: Message): boolean {
    const client = getClient(channelName);
    if (!client) return false;
    try {
        client.send(msg);
        return true;
    } catch {
        return false;
    }
}

export function registerAgentTools(pi: ExtensionAPI): void {
    const identity = getIdentity();

    // === hive_progress ===
    pi.registerTool({
        name: "hive_progress",
        label: "Hive Progress",
        description:
            "Report your current progress to the swarm dashboard. " +
            "Fire-and-forget — no response expected. Use this to show what phase you're in, " +
            "how far along you are, or what you're currently doing.",
        parameters: Type.Object({
            phase: Type.Optional(Type.String({
                description: "Current phase (e.g. 'reading files', 'running tests', 'writing report')",
            })),
            percent: Type.Optional(Type.Number({
                description: "Completion percentage 0-100",
            })),
            detail: Type.Optional(Type.String({
                description: "Short status line",
            })),
        }),
        async execute(_toolCallId, params) {
            const parts: string[] = [];
            if (params.phase) parts.push(params.phase);
            if (params.percent != null) parts.push(`${params.percent}%`);
            if (params.detail) parts.push(params.detail);

            const msg: Message = {
                msg: parts.join(" — ") || "progress",
                data: {
                    type: "progress",
                    from: identity.name,
                    role: identity.role,
                    phase: params.phase,
                    percent: params.percent,
                    detail: params.detail,
                },
            };

            const sentQueen = sendToChannel(QUEEN_INBOX, msg);
            const sentGeneral = sendToChannel(GENERAL_CHANNEL, msg);
            if (!sentQueen && !sentGeneral) {
                return {
                    content: [{ type: "text", text: "Not connected to swarm channels. Progress not sent." }],
                    details: {},
                    isError: true,
                };
            }

            return {
                content: [{ type: "text", text: `Progress: ${parts.join(" — ") || "(empty)"}` }],
                details: {},
            };
        },
        renderCall(args, theme) {
            const parts: string[] = [];
            if (args.phase) parts.push(args.phase);
            if (args.percent != null) parts.push(`${args.percent}%`);
            if (args.detail) parts.push(args.detail);
            return new Text(
                theme.fg("toolTitle", theme.bold("hive_progress ")) +
                    theme.fg("dim", parts.join(" — ") || "..."),
                0,
                0,
            );
        },
        renderResult(result, _opts, theme) {
            const text = result.content[0];
            const content = text?.type === "text" ? text.text : "";
            const color = result.isError ? "error" : "success";
            return new Text(theme.fg(color, content), 0, 0);
        },
    });

    // === hive_notify ===
    pi.registerTool({
        name: "hive_notify",
        label: "Hive Notify",
        description:
            "Nudge your swarm teammates to check the hive-mind file. " +
            "Call this AFTER updating the hive-mind with your findings. " +
            "The reason should be a short label — put details in the hive-mind file. " +
            "Optional payload fields add context so recipients can triage without file I/O. " +
            "Optional 'to' field sends only to a specific agent by name.",
        parameters: Type.Object({
            reason: Type.String({
                description: "Brief description of what you added to the hive-mind",
            }),
            to: Type.Optional(Type.String({
                description: "Send only to a specific agent by name (omit to broadcast)",
            })),
            file: Type.Optional(Type.String({
                description: "File path that was updated",
            })),
            snippet: Type.Optional(Type.String({
                description: "Short excerpt of what was added",
            })),
            section: Type.Optional(Type.String({
                description: "Hive-mind section that was updated",
            })),
            tags: Type.Optional(Type.Array(Type.String(), {
                description: "Topic tags for interest-based filtering",
            })),
        }),
        async execute(_toolCallId, params) {
            const payload: Record<string, unknown> = {};
            if (params.file) payload.file = params.file;
            if (params.snippet) payload.snippet = params.snippet;
            if (params.section) payload.section = params.section;
            if (params.tags) payload.tags = params.tags;

            const msg: Message = {
                msg: params.reason,
                data: {
                    type: "nudge",
                    from: identity.name,
                    role: identity.role,
                    reason: params.reason,
                    to: params.to,
                    ...payload,
                },
            };

            let sent = false;
            if (params.to) {
                // Targeted: send to specific agent's inbox + general so queen sees it
                const sentInbox = sendToChannel(inboxName(params.to), msg);
                const sentGeneral = sendToChannel(GENERAL_CHANNEL, msg);
                sent = sentInbox || sentGeneral;
            } else {
                // Broadcast: send to general
                sent = sendToChannel(GENERAL_CHANNEL, msg);
            }

            if (!sent) {
                return {
                    content: [{ type: "text", text: "Not connected to swarm channels. Notification not sent." }],
                    details: {},
                    isError: true,
                };
            }

            const target = params.to ? ` → ${params.to}` : "";
            return {
                content: [{ type: "text", text: `Nudge sent${target}: "${params.reason}"` }],
                details: {},
            };
        },
        renderCall(args, theme) {
            let text = theme.fg("toolTitle", theme.bold("hive_notify ")) +
                theme.fg("dim", args.reason || "...");
            if (args.to) {
                text += theme.fg("accent", ` → ${args.to}`);
            }
            return new Text(text, 0, 0);
        },
        renderResult(result, _opts, theme) {
            const text = result.content[0];
            const content = text?.type === "text" ? text.text : "";
            const color = result.isError ? "error" : "success";
            return new Text(theme.fg(color, content), 0, 0);
        },
    });

    // === hive_blocker ===
    pi.registerTool({
        name: "hive_blocker",
        label: "Hive Blocker",
        description:
            "Signal that you're blocked on something that affects the swarm. " +
            "Call this immediately when stuck — don't silently spin. " +
            "Also update the Blockers section of the hive-mind file.",
        parameters: Type.Object({
            description: Type.String({
                description: "Brief description of what's blocking you",
            }),
        }),
        async execute(_toolCallId, params) {
            const msg: Message = {
                msg: params.description,
                data: {
                    type: "blocker",
                    from: identity.name,
                    role: identity.role,
                    description: params.description,
                },
            };

            const sentQueen = sendToChannel(QUEEN_INBOX, msg);
            const sentGeneral = sendToChannel(GENERAL_CHANNEL, msg);
            if (!sentQueen && !sentGeneral) {
                return {
                    content: [{ type: "text", text: "Not connected to swarm channels. Blocker not sent." }],
                    details: {},
                    isError: true,
                };
            }

            return {
                content: [{ type: "text", text: `Blocker signalled: "${params.description}"` }],
                details: {},
            };
        },
        renderCall(args, theme) {
            return new Text(
                theme.fg("toolTitle", theme.bold("hive_blocker ")) +
                    theme.fg("warning", args.description || "..."),
                0,
                0,
            );
        },
        renderResult(result, _opts, theme) {
            const text = result.content[0];
            const content = text?.type === "text" ? text.text : "";
            return new Text(theme.fg(result.isError ? "error" : "warning", content), 0, 0);
        },
    });

    // === hive_done ===
    pi.registerTool({
        name: "hive_done",
        label: "Hive Done",
        description:
            "Signal that your task is complete. " +
            "Call this as the LAST thing you do. " +
            "Include a one-line summary of what you accomplished.",
        parameters: Type.Object({
            summary: Type.String({
                description: "One-line summary of completed work",
            }),
        }),
        async execute(_toolCallId, params) {
            const msg: Message = {
                msg: params.summary,
                data: {
                    type: "done",
                    from: identity.name,
                    role: identity.role,
                    summary: params.summary,
                },
            };

            // Send to both queen inbox and general
            const sentQueen = sendToChannel(QUEEN_INBOX, msg);
            const sentGeneral = sendToChannel(GENERAL_CHANNEL, msg);

            if (!sentQueen && !sentGeneral) {
                return {
                    content: [{ type: "text", text: "Not connected to swarm channels. Done signal not sent." }],
                    details: {},
                    isError: true,
                };
            }

            return {
                content: [{ type: "text", text: `Done: "${params.summary}"` }],
                details: {},
            };
        },
        renderCall(args, theme) {
            return new Text(
                theme.fg("toolTitle", theme.bold("hive_done ")) +
                    theme.fg("success", args.summary || "..."),
                0,
                0,
            );
        },
        renderResult(result, _opts, theme) {
            const text = result.content[0];
            const content = text?.type === "text" ? text.text : "";
            return new Text(theme.fg(result.isError ? "error" : "success", content), 0, 0);
        },
    });
}
