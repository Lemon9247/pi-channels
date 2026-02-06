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
import type { RelayedMessage } from "../transport/protocol.js";

export function setupNotifications(pi: ExtensionAPI, client: SwarmClient): void {
    client.on("message", (relayed: RelayedMessage) => {
        const { from, message } = relayed;
        // from is now a MessageSender object with name, role, swarm
        const senderName = typeof from === "string" ? from : from.name;
        const senderRole = typeof from === "string" ? (relayed as any).fromRole : from.role;

        switch (message.type) {
            case "blocker": {
                const text =
                    `⚠️ **Blocker from ${senderName}** (${senderRole}): ${message.description}\n\n` +
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
                    `📋 **Instruction from ${senderName}** (${senderRole}): ${message.instruction}\n\n` +
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
                const text =
                    `🔔 **Nudge from ${senderName}** (${senderRole}): ${message.reason}\n\n` +
                    `Check the hive-mind file — another agent found something that may affect your work.`;
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
