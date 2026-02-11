/**
 * Notification Handler
 *
 * Listens for incoming messages on channel clients and injects
 * them into the agent's context using pi.sendMessage().
 *
 * Message filtering (C1, C2, C7 fixes):
 * - Sender identity check: skip messages from self
 * - Swarm filter: skip instruct messages for other swarms
 * - Target filter: skip messages addressed to other agents
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
import type { ChannelClient, Message } from "agent-channels";
import { getIdentity } from "../core/identity.js";

/**
 * Check whether a message should be processed by this agent.
 * Exported for testing.
 */
export function shouldProcessMessage(
    msg: Message,
    myName: string,
    mySwarm: string | undefined,
): boolean {
    if (!msg.data || !msg.data.type) return false;

    const senderName = (msg.data.from as string) || "";

    // C7: Skip own messages — fan-out echoes our own broadcasts back
    if (senderName && senderName === myName) return false;

    const type = msg.data.type as string;

    // C2: Swarm-level filter on instruct messages
    if (type === "instruct" && msg.data.swarm && mySwarm) {
        if (msg.data.swarm !== mySwarm) return false;
    }

    return true;
}

export function setupNotifications(pi: ExtensionAPI, clients: Map<string, ChannelClient>): void {
    const identity = getIdentity();
    const myName = identity.name;
    const mySwarm = identity.swarm;

    for (const [channelName, client] of clients.entries()) {
        client.on("message", (msg: Message) => {
            if (!shouldProcessMessage(msg, myName, mySwarm)) return;

            const type = msg.data!.type as string;
            const senderName = (msg.data!.from as string) || "unknown";
            const senderRole = (msg.data!.role as string) || "agent";

            switch (type) {
                case "blocker": {
                    const description = (msg.data!.description as string) || msg.msg;
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
                    const to = msg.data!.to as string | undefined;
                    if (to && to !== myName) break;
                    const instruction = (msg.data!.instruction as string) || msg.msg;
                    const from = (msg.data!.from as string) || "queen";
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
                    const to = msg.data!.to as string | undefined;
                    if (to && to !== myName) break;
                    const reason = (msg.data!.reason as string) || msg.msg;
                    let text =
                        `🔔 **Nudge from ${senderName}** (${senderRole}): ${reason}\n\n`;

                    // Include payload context if available
                    const parts: string[] = [];
                    if (msg.data!.section) parts.push(`Section: ${msg.data!.section}`);
                    if (msg.data!.file) parts.push(`File: \`${msg.data!.file}\``);
                    if (msg.data!.snippet) parts.push(`> ${msg.data!.snippet}`);
                    if (msg.data!.tags && Array.isArray(msg.data!.tags)) {
                        parts.push(`Tags: ${(msg.data!.tags as string[]).join(", ")}`);
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
