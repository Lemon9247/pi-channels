/**
 * Notification Handler
 *
 * Listens for incoming messages on channel clients and injects
 * them into the agent's context using pi.sendMessage().
 *
 * Delivery rules:
 * - blocker → steer (interrupts after current tool)
 * - instruct → steer (direct intervention, interrupt and adjust)
 * - nudge → followUp (waits for current tool chain to finish)
 * - done → no context injection (tracked in state only)
 * - relay → no context injection (handled by swarm tool)
 * - progress → no context injection (dashboard only)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { ChannelClient, Message } from "../../../../agent-channels/dist/index.js";

export function setupNotifications(pi: ExtensionAPI, clients: Map<string, ChannelClient>): void {
    for (const [channelName, client] of clients.entries()) {
        client.on("message", (msg: Message) => {
            if (!msg.data || !msg.data.type) return;

            const type = msg.data.type as string;
            const senderName = (msg.data.from as string) || "unknown";
            const senderRole = (msg.data.role as string) || "agent";

            switch (type) {
                case "blocker": {
                    const description = (msg.data.description as string) || msg.msg;
                    const text =
                        `⚠️ **Blocker from ${senderName}** (${senderRole}): ${description}\n\n` +
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
                    const instruction = (msg.data.instruction as string) || msg.msg;
                    const from = (msg.data.from as string) || "queen";
                    const text =
                        `📋 **Instruction from ${from}**: ${instruction}\n\n` +
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
                    const reason = (msg.data.reason as string) || msg.msg;
                    let text =
                        `🔔 **Nudge from ${senderName}** (${senderRole}): ${reason}\n\n`;

                    // Include payload context if available
                    const parts: string[] = [];
                    if (msg.data.section) parts.push(`Section: ${msg.data.section}`);
                    if (msg.data.file) parts.push(`File: \`${msg.data.file}\``);
                    if (msg.data.snippet) parts.push(`> ${msg.data.snippet}`);
                    if (msg.data.tags && Array.isArray(msg.data.tags)) {
                        parts.push(`Tags: ${(msg.data.tags as string[]).join(", ")}`);
                    }
                    if (parts.length > 0) text += parts.join("\n") + "\n\n";

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

                case "done":
                case "relay":
                case "progress":
                    // Informational — tracked via state/dashboard, not injected into context
                    break;
            }
        });

        client.on("error", (err: Error) => {
            pi.sendMessage(
                {
                    customType: "swarm-error",
                    content: `Channel error (${channelName}): ${err.message || err}`,
                    display: true,
                },
                { deliverAs: "followUp" },
            );
        });
    }
}
