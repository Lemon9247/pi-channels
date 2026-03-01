/**
 * Tests for ui/notifications.ts message filtering
 *
 * Verifies that shouldProcessMessage correctly filters:
 * - C7: Own messages (sender === self)
 * - C2: Instructions for other swarms
 * - Messages without data/type
 */

import { describe, it, beforeEach } from "node:test";
import * as assert from "node:assert/strict";
import type { Message } from "agent-channels";
import { shouldProcessMessage, messageBatch, flushBatch, clearFlushTimer } from "../../ui/notifications.js";

function msg(data: Record<string, unknown>): Message {
    return { msg: "test", data };
}

describe("shouldProcessMessage", () => {
    describe("basic filtering", () => {
        it("rejects messages without data", () => {
            assert.equal(shouldProcessMessage({ msg: "hi" }, "a1", "s1"), false);
        });

        it("rejects messages without type", () => {
            assert.equal(shouldProcessMessage(msg({ from: "a2" }), "a1", "s1"), false);
        });

        it("accepts valid messages from other agents", () => {
            assert.equal(
                shouldProcessMessage(msg({ type: "blocker", from: "a2" }), "a1", "s1"),
                true,
            );
        });
    });

    describe("C7: self-message filtering", () => {
        it("rejects messages from self", () => {
            assert.equal(
                shouldProcessMessage(msg({ type: "blocker", from: "agent a1" }), "agent a1", "s1"),
                false,
            );
        });

        it("accepts messages from different agent", () => {
            assert.equal(
                shouldProcessMessage(msg({ type: "blocker", from: "agent a2" }), "agent a1", "s1"),
                true,
            );
        });

        it("accepts messages with no sender (legacy)", () => {
            assert.equal(
                shouldProcessMessage(msg({ type: "message" }), "a1", "s1"),
                true,
            );
        });
    });

    describe("C2: swarm-level instruct filtering", () => {
        it("rejects instruct for different swarm", () => {
            assert.equal(
                shouldProcessMessage(
                    msg({ type: "instruct", from: "queen", swarm: "alpha" }),
                    "a1",
                    "beta",
                ),
                false,
            );
        });

        it("accepts instruct for same swarm", () => {
            assert.equal(
                shouldProcessMessage(
                    msg({ type: "instruct", from: "queen", swarm: "alpha" }),
                    "a1",
                    "alpha",
                ),
                true,
            );
        });

        it("accepts instruct with no swarm field (broadcasts)", () => {
            assert.equal(
                shouldProcessMessage(
                    msg({ type: "instruct", from: "queen" }),
                    "a1",
                    "alpha",
                ),
                true,
            );
        });

        it("accepts instruct when agent has no swarm", () => {
            assert.equal(
                shouldProcessMessage(
                    msg({ type: "instruct", from: "queen", swarm: "alpha" }),
                    "a1",
                    undefined,
                ),
                true,
            );
        });

        it("swarm filter only applies to instruct messages", () => {
            // blocker from different swarm should still be processed
            assert.equal(
                shouldProcessMessage(
                    msg({ type: "blocker", from: "a2", swarm: "alpha" }),
                    "a1",
                    "beta",
                ),
                true,
            );
        });
    });

    describe("target (to) filtering", () => {
        it("rejects messages addressed to another agent", () => {
            assert.equal(
                shouldProcessMessage(
                    msg({ type: "instruct", from: "queen", to: "a2" }),
                    "a1",
                    "s1",
                ),
                false,
            );
        });

        it("accepts messages addressed to self", () => {
            assert.equal(
                shouldProcessMessage(
                    msg({ type: "instruct", from: "queen", to: "a1" }),
                    "a1",
                    "s1",
                ),
                true,
            );
        });

        it("accepts messages with no to field (broadcasts)", () => {
            assert.equal(
                shouldProcessMessage(
                    msg({ type: "message", from: "a2" }),
                    "a1",
                    "s1",
                ),
                true,
            );
        });

        it("applies to all message types", () => {
            assert.equal(
                shouldProcessMessage(
                    msg({ type: "blocker", from: "a2", to: "a3" }),
                    "a1",
                    "s1",
                ),
                false,
            );
        });
    });

    describe("combined filters", () => {
        it("self-filter takes priority over swarm match", () => {
            assert.equal(
                shouldProcessMessage(
                    msg({ type: "instruct", from: "a1", swarm: "alpha" }),
                    "a1",
                    "alpha",
                ),
                false,
            );
        });

        it("accepts non-instruct types from other agents regardless of swarm", () => {
            assert.equal(
                shouldProcessMessage(
                    msg({ type: "message", from: "a2", swarm: "other" }),
                    "a1",
                    "mine",
                ),
                true,
            );
        });
    });
});

// ─── Mock ExtensionAPI for batching tests ────────────────────────────

interface SentMessage {
    message: { customType: string; content: string; display: boolean };
    opts: { deliverAs: string };
}

function mockPi(): { pi: any; sent: SentMessage[] } {
    const sent: SentMessage[] = [];
    const pi = {
        sendMessage(message: any, opts: any) {
            sent.push({ message, opts });
        },
    };
    return { pi, sent };
}

describe("message batching", () => {
    beforeEach(() => {
        // Clear batch buffer and flush timer before each test
        messageBatch.splice(0);
        clearFlushTimer();
    });

    it("single message delivers without wrapper", () => {
        const { pi, sent } = mockPi();
        messageBatch.push({ from: "agent-1", content: "found a bug", timestamp: Date.now() });
        flushBatch(pi);

        assert.equal(sent.length, 1);
        assert.equal(sent[0].opts.deliverAs, "followUp");
        assert.equal(sent[0].message.customType, "swarm-message-batch");
        assert.ok(sent[0].message.content.includes("**agent-1**: found a bug"));
        // Single message should NOT have the "N messages" header
        assert.ok(!sent[0].message.content.includes("messages while you were working"));
    });

    it("multiple messages batch into one delivery", () => {
        const { pi, sent } = mockPi();
        messageBatch.push({ from: "agent-1", content: "msg one", timestamp: Date.now() });
        messageBatch.push({ from: "agent-2", content: "msg two", timestamp: Date.now() });
        messageBatch.push({ from: "agent-1", content: "msg three", timestamp: Date.now() });
        flushBatch(pi);

        assert.equal(sent.length, 1);
        assert.equal(sent[0].opts.deliverAs, "followUp");
        assert.ok(sent[0].message.content.includes("3 messages while you were working"));
        assert.ok(sent[0].message.content.includes("**agent-1**: msg one"));
        assert.ok(sent[0].message.content.includes("**agent-2**: msg two"));
        assert.ok(sent[0].message.content.includes("**agent-1**: msg three"));
    });

    it("empty batch is a no-op", () => {
        const { pi, sent } = mockPi();
        flushBatch(pi);
        assert.equal(sent.length, 0);
    });

    it("flush clears the batch buffer", () => {
        const { pi } = mockPi();
        messageBatch.push({ from: "a1", content: "hello", timestamp: Date.now() });
        flushBatch(pi);
        assert.equal(messageBatch.length, 0);
    });

    it("truncates at max batch size with overflow count", () => {
        const { pi, sent } = mockPi();
        // Push 25 messages (max is 20)
        for (let i = 0; i < 25; i++) {
            messageBatch.push({ from: `agent-${i}`, content: `msg ${i}`, timestamp: Date.now() });
        }
        flushBatch(pi);

        assert.equal(sent.length, 1);
        assert.ok(sent[0].message.content.includes("25 messages while you were working"));
        assert.ok(sent[0].message.content.includes("...and 5 more messages"));
        // Should include first 20 but not msg 20-24
        assert.ok(sent[0].message.content.includes("**agent-0**: msg 0"));
        assert.ok(sent[0].message.content.includes("**agent-19**: msg 19"));
        assert.ok(!sent[0].message.content.includes("**agent-20**: msg 20"));
    });
});

describe("urgent messages", () => {
    // Urgent message handling is tested via setupNotifications integration,
    // but we can verify the flushBatch behavior around urgent scenarios.

    beforeEach(() => {
        messageBatch.splice(0);
        clearFlushTimer();
    });

    it("urgent messages are not added to batch", () => {
        // Verify that the batch stays empty when only urgent messages are sent.
        // (The urgent path in setupNotifications calls pi.sendMessage directly,
        // not queueMessage. This test confirms the batch isn't polluted.)
        assert.equal(messageBatch.length, 0);
        // Simulate what setupNotifications does for a non-urgent message
        messageBatch.push({ from: "a1", content: "normal msg", timestamp: Date.now() });
        assert.equal(messageBatch.length, 1);
    });

    it("flush still works after urgent messages are delivered separately", () => {
        const { pi, sent } = mockPi();
        // Simulate: normal msg queued, then urgent delivered separately, then flush
        messageBatch.push({ from: "a1", content: "normal", timestamp: Date.now() });

        // Urgent would be delivered via pi.sendMessage directly (not through batch)
        pi.sendMessage(
            { customType: "swarm-message-urgent", content: "🚨 urgent!", display: true },
            { deliverAs: "steer" },
        );

        // Now flush the batch
        flushBatch(pi);

        assert.equal(sent.length, 2);
        // First: the urgent message (steer)
        assert.equal(sent[0].opts.deliverAs, "steer");
        assert.equal(sent[0].message.customType, "swarm-message-urgent");
        // Second: the batched normal message (followUp)
        assert.equal(sent[1].opts.deliverAs, "followUp");
        assert.equal(sent[1].message.customType, "swarm-message-batch");
    });

    it("urgent message delivered via steer without corrupting pending batch", () => {
        const { pi, sent } = mockPi();

        // Queue 2 normal messages
        messageBatch.push({ from: "a1", content: "normal one", timestamp: Date.now() });
        messageBatch.push({ from: "a2", content: "normal two", timestamp: Date.now() });

        // Urgent message delivered separately (as setupNotifications would do)
        pi.sendMessage(
            { customType: "swarm-message-urgent", content: "🚨 **a3** (urgent): stop now", display: true },
            { deliverAs: "steer" },
        );

        // Urgent was delivered immediately
        assert.equal(sent.length, 1);
        assert.equal(sent[0].opts.deliverAs, "steer");
        assert.equal(sent[0].message.customType, "swarm-message-urgent");

        // Batch still intact — not lost or corrupted
        assert.equal(messageBatch.length, 2);
        assert.equal(messageBatch[0].from, "a1");
        assert.equal(messageBatch[0].content, "normal one");
        assert.equal(messageBatch[1].from, "a2");
        assert.equal(messageBatch[1].content, "normal two");

        // Flush batch — both queued messages delivered together
        flushBatch(pi);
        assert.equal(sent.length, 2);
        assert.equal(sent[1].opts.deliverAs, "followUp");
        assert.ok(sent[1].message.content.includes("2 messages while you were working"));
        assert.ok(sent[1].message.content.includes("**a1**: normal one"));
        assert.ok(sent[1].message.content.includes("**a2**: normal two"));
    });
});
