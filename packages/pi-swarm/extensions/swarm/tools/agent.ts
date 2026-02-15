/**
 * Agent Tools
 *
 * Tools available to agents inside a swarm:
 * - message: Send a message through swarm channels (replaces hive_notify + hive_progress)
 * - hive_blocker: Signal that you're blocked
 * - hive_done: Signal task completion
 *
 * Each tool sends a Message to the appropriate channel(s).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import type { ChannelClient, Message } from "agent-channels";
import { getParentClients } from "../core/state.js";
import { getIdentity } from "../core/identity.js";
import { GENERAL_CHANNEL, QUEEN_INBOX, ENV, inboxName } from "../core/channels.js";

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
    const topicChannel = process.env[ENV.TOPIC] || "";

    // === message ===
    pi.registerTool({
        name: "message",
        label: "Message",
        description:
            "Send a message through swarm channels. The content IS the message — " +
            "channels carry real information, not just labels pointing at files.\n\n" +
            "Use this for coordination, sharing findings, asking questions, and progress updates. " +
            "Reserve the notes file for persistent artifacts (code snippets, detailed analysis) " +
            "that need to survive the session.\n\n" +
            "Optional 'to' field sends to a specific agent. " +
            "Optional 'progress' field updates the dashboard." +
            (topicChannel
                ? " Defaults to your team channel. Set broadcast=true for cross-team announcements."
                : ""),
        parameters: Type.Object({
            content: Type.String({
                description: "The message content — this is what recipients will read",
            }),
            to: Type.Optional(Type.String({
                description: "Send to a specific agent by name (omit to broadcast)",
            })),
            broadcast: Type.Optional(Type.Boolean({
                description: "Send to general channel instead of team channel",
            })),
            progress: Type.Optional(Type.Object({
                phase: Type.Optional(Type.String({
                    description: "Current phase (e.g. 'reading files', 'running tests')",
                })),
                percent: Type.Optional(Type.Number({
                    description: "Completion percentage 0-100",
                })),
            })),
        }),
        async execute(_toolCallId, params) {
            const msg: Message = {
                msg: params.content,
                data: {
                    type: "message",
                    from: identity.name,
                    role: identity.role,
                    content: params.content,
                    to: params.to,
                    progress: params.progress,
                },
            };

            let sent = false;
            if (params.to) {
                // Targeted: send to agent inbox + general so queen sees it
                const sentInbox = sendToChannel(inboxName(params.to), msg);
                const sentGeneral = sendToChannel(GENERAL_CHANNEL, msg);
                sent = sentInbox || sentGeneral;
            } else if (topicChannel && !params.broadcast) {
                // Team-scoped: topic channel (queen monitors it too)
                sent = sendToChannel(topicChannel, msg);
            } else {
                // Broadcast: general channel
                sent = sendToChannel(GENERAL_CHANNEL, msg);
            }

            if (!sent) {
                return {
                    content: [{ type: "text", text: "Not connected to swarm channels. Message not sent." }],
                    details: {},
                    isError: true,
                };
            }

            const target = params.to ? ` → ${params.to}` : topicChannel && !params.broadcast ? ` [${topicChannel}]` : "";
            const preview = params.content.length > 60 ? params.content.slice(0, 60) + "…" : params.content;
            return {
                content: [{ type: "text", text: `Message sent${target}: "${preview}"` }],
                details: {},
            };
        },
        renderCall(args, theme) {
            const preview = (args.content || "").length > 60
                ? (args.content as string).slice(0, 60) + "…"
                : (args.content || "...");
            let text = theme.fg("toolTitle", theme.bold("message ")) +
                theme.fg("dim", preview);
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
