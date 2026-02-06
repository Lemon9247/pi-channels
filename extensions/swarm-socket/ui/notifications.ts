/**
 * Notification Handler
 *
 * Listens for incoming messages on the socket client and injects
 * them into the agent's context using pi.sendMessage().
 *
 * Delivery rules:
 * - blocker → steer (interrupts after current tool)
 * - instruct → steer (direct intervention, interrupt and adjust)
 * - nudge → followUp (waits for current tool chain to finish)
 * - done → no context injection (tracked in state only)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { SwarmClient } from "../core/client.js";
import type { RelayedMessage, NudgeMessage } from "../transport/protocol.js";

export function setupNotifications(pi: ExtensionAPI, client: SwarmClient): void {
    client.on("message", (relayed: RelayedMessage) => {
        const { from, fromRole, message } = relayed;

        switch (message.type) {
            case "blocker": {
                const text =
                    `⚠️ **Blocker from ${from}** (${fromRole}): ${message.description}\n\n` +
                    `Check the hive-mind file for details. Consider if this affects your work.`;
                pi.sendMessage(
                    {
                        customType: "swarm-blocker",
                        content: text,
                        display: true,
                    },
                    { deliverAs: "steer" },
                );
                break;
            }

            case "instruct": {
                const text =
                    `📋 **Instruction from ${from}** (${fromRole}): ${message.instruction}\n\n` +
                    `Adjust your approach based on this instruction.`;
                pi.sendMessage(
                    {
                        customType: "swarm-instruct",
                        content: text,
                        display: true,
                    },
                    { deliverAs: "steer" },
                );
                break;
            }

            case "nudge": {
                const nudge = message as NudgeMessage;
                let text =
                    `🔔 **Nudge from ${from}** (${fromRole}): ${nudge.reason}\n\n`;
                if (nudge.payload) {
                    const parts: string[] = [];
                    if (nudge.payload.section) parts.push(`Section: ${nudge.payload.section}`);
                    if (nudge.payload.file) parts.push(`File: \`${nudge.payload.file}\``);
                    if (nudge.payload.snippet) parts.push(`> ${nudge.payload.snippet}`);
                    if (nudge.payload.tags?.length) parts.push(`Tags: ${nudge.payload.tags.join(", ")}`);
                    if (parts.length > 0) text += parts.join("\n") + "\n\n";
                }
                text += `Check the hive-mind file — another agent found something that may affect your work.`;
                pi.sendMessage(
                    {
                        customType: "swarm-nudge",
                        content: text,
                        display: true,
                    },
                    { deliverAs: "followUp" },
                );
                break;
            }

            case "done": {
                // Don't inject into context — tracked via state
                break;
            }

            case "relay": {
                // Relay messages are handled by the swarm tool, not by individual agents
                break;
            }

            case "progress": {
                // Progress messages are informational — tracked via dashboard/activity
                break;
            }
        }
    });

    client.on("error", (message: string) => {
        pi.sendMessage(
            {
                customType: "swarm-error",
                content: `Swarm socket error: ${message}`,
                display: true,
            },
            { deliverAs: "followUp" },
        );
    });
}
