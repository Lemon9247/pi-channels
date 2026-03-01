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
 * - message → batched followUp (queued, flushed after 50ms debounce)
 * - message (urgent) → steer (bypasses batch, immediate delivery)
 * - done → no context injection (tracked in state only)
 * - relay → no context injection (handled by swarm tool)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { ChannelClient, Message } from "agent-channels";
import { getIdentity } from "../core/identity.js";

// ─── Message Batching ────────────────────────────────────────────────

/** Max messages in a single batch before truncation. */
const MAX_BATCH_SIZE = 20;

interface BatchEntry {
    from: string;
    content: string;
    timestamp: number;
}

/** Module-level batch buffer. Exported for testing. */
export const messageBatch: BatchEntry[] = [];

/** Debounce delay for batch flush (ms). */
const FLUSH_DELAY = 50;

/** Debounced flush timer. */
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/** Clear the debounced flush timer (for testing). */
export function clearFlushTimer(): void {
    if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }
}

/**
 * Queue a message for batched delivery.
 */
function queueMessage(from: string, content: string): void {
    messageBatch.push({ from, content, timestamp: Date.now() });
}

/**
 * Flush all queued messages as a single coherent delivery.
 * Single message: delivers normally without wrapper.
 * Multiple messages: formats as a summary list.
 * Truncates at MAX_BATCH_SIZE with overflow count.
 */
export function flushBatch(pi: ExtensionAPI): void {
    if (messageBatch.length === 0) return;

    const messages = messageBatch.splice(0);
    let text: string;

    if (messages.length === 1) {
        text = `💬 **${messages[0].from}**: ${messages[0].content}`;
    } else {
        const shown = messages.slice(0, MAX_BATCH_SIZE);
        const formatted = shown
            .map((m) => `**${m.from}**: ${m.content}`)
            .join("\n\n");
        text = `💬 **${messages.length} messages while you were working:**\n\n${formatted}`;
        if (messages.length > MAX_BATCH_SIZE) {
            text += `\n\n...and ${messages.length - MAX_BATCH_SIZE} more messages`;
        }
    }

    pi.sendMessage(
        { customType: "swarm-message-batch", content: text, display: true },
        { deliverAs: "followUp" },
    );
}

/**
 * Check whether a message should be processed by this agent.
 * Exported for testing.
 *
 * Filters:
 * - Messages without data/type (not swarm messages)
 * - C7: Own messages (sender === self)
 * - C2: Instructions for other swarms
 * - Targeted messages (to field) addressed to other agents
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

    // Target filter: skip messages addressed to other agents
    const to = msg.data.to as string | undefined;
    if (to && to !== myName) return false;

    return true;
}

export function setupNotifications(pi: ExtensionAPI, clients: Map<string, ChannelClient>): void {
    const identity = getIdentity();
    const myName = identity.name;
    const mySwarm = identity.swarm;

    for (const [channelName, client] of clients.entries()) {
        client.on("message", (msg: Message) => {
            if (!shouldProcessMessage(msg, myName, mySwarm)) return;

            // Safe to assert — shouldProcessMessage checks data/type exist
            const data = msg.data!;
            const type = data.type as string;
            const senderName = (data.from as string) || "unknown";
            const senderRole = (data.role as string) || "agent";

            switch (type) {
                case "blocker": {
                    flushBatch(pi);
                    const description = (data.description as string) || msg.msg;
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
                    flushBatch(pi);
                    const instruction = (data.instruction as string) || msg.msg;
                    const from = (data.from as string) || "queen";
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

                case "message": {
                    const content = (data.content as string) || msg.msg;
                    const urgent = data.urgent as boolean | undefined;
                    if (urgent) {
                        // Urgent: bypass batch, deliver immediately as steer
                        pi.sendMessage(
                            {
                                customType: "swarm-message-urgent",
                                content: `🚨 **${senderName}** (urgent): ${content}`,
                                display: true,
                            },
                            { deliverAs: "steer" },
                        );
                    } else {
                        // Normal: queue for batched delivery
                        queueMessage(senderName, content);
                        // Debounced flush: messages arriving in quick succession
                        // (typical during tool chains) accumulate before delivery
                        if (!flushTimer) {
                            flushTimer = setTimeout(() => {
                                flushTimer = null;
                                flushBatch(pi);
                            }, FLUSH_DELAY);
                        }
                    }
                    break;
                }

                case "done":
                case "relay":
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
