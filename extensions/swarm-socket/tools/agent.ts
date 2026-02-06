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
    pi.registerTool({
        name: "hive_notify",
        label: "Hive Notify",
        description:
            "Nudge your swarm teammates to check the hive-mind file. " +
            "Call this AFTER updating the hive-mind with your findings. " +
            "The reason should be a short label — put details in the hive-mind file.",
        parameters: Type.Object({
            reason: Type.String({
                description: "Brief description of what you added to the hive-mind",
            }),
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
                client.nudge(params.reason);
                return {
                    content: [{ type: "text", text: `Nudge sent: "${params.reason}"` }],
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
            return new Text(
                theme.fg("toolTitle", theme.bold("hive_notify ")) +
                    theme.fg("dim", args.reason || "..."),
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
