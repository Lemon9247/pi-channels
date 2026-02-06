/**
 * Agent Tools
 *
 * Tools available to agents inside a swarm:
 * - hive_notify: Nudge teammates to check the hive-mind
 * - hive_blocker: Signal that you're blocked
 * - hive_done: Signal task completion
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { SwarmClient } from "../core/client.js";

export function registerAgentTools(pi: ExtensionAPI, client: SwarmClient): void {
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
            if (!client.connected) {
                return {
                    content: [{ type: "text", text: "Not connected to swarm socket. Progress not sent." }],
                    details: {},
                    isError: true,
                };
            }
            try {
                client.progress({
                    phase: params.phase,
                    percent: params.percent,
                    detail: params.detail,
                });
                const parts: string[] = [];
                if (params.phase) parts.push(params.phase);
                if (params.percent != null) parts.push(`${params.percent}%`);
                if (params.detail) parts.push(params.detail);
                return {
                    content: [{ type: "text", text: `Progress: ${parts.join(" — ") || "(empty)"}` }],
                    details: {},
                };
            } catch (err) {
                return {
                    content: [{ type: "text", text: `Failed to send progress: ${err}` }],
                    details: {},
                    isError: true,
                };
            }
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
            if (!client.connected) {
                return {
                    content: [{ type: "text", text: "Not connected to swarm socket. Notification not sent." }],
                    details: {},
                    isError: true,
                };
            }
            try {
                const payload: Record<string, unknown> = {};
                if (params.file) payload.file = params.file;
                if (params.snippet) payload.snippet = params.snippet;
                if (params.section) payload.section = params.section;
                if (params.tags) payload.tags = params.tags;
                const hasPayload = Object.keys(payload).length > 0;

                client.nudge(params.reason, {
                    to: params.to,
                    payload: hasPayload ? payload as any : undefined,
                });
                const target = params.to ? ` → ${params.to}` : "";
                return {
                    content: [{ type: "text", text: `Nudge sent${target}: "${params.reason}"` }],
                    details: {},
                };
            } catch (err) {
                return {
                    content: [{ type: "text", text: `Failed to send nudge: ${err}` }],
                    details: {},
                    isError: true,
                };
            }
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
            if (!client.connected) {
                return {
                    content: [{ type: "text", text: "Not connected to swarm socket. Blocker not sent." }],
                    details: {},
                    isError: true,
                };
            }
            try {
                client.blocker(params.description);
                return {
                    content: [{ type: "text", text: `Blocker signalled: "${params.description}"` }],
                    details: {},
                };
            } catch (err) {
                return {
                    content: [{ type: "text", text: `Failed to send blocker: ${err}` }],
                    details: {},
                    isError: true,
                };
            }
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
            if (!client.connected) {
                return {
                    content: [{ type: "text", text: "Not connected to swarm socket. Done signal not sent." }],
                    details: {},
                    isError: true,
                };
            }
            try {
                client.done(params.summary);
                return {
                    content: [{ type: "text", text: `Done: "${params.summary}"` }],
                    details: {},
                };
            } catch (err) {
                return {
                    content: [{ type: "text", text: `Failed to send done: ${err}` }],
                    details: {},
                    isError: true,
                };
            }
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
