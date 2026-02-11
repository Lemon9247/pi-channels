/**
 * Tests for ui/notifications.ts message filtering
 *
 * Verifies that shouldProcessMessage correctly filters:
 * - C7: Own messages (sender === self)
 * - C2: Instructions for other swarms
 * - Messages without data/type
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import type { Message } from "agent-channels";
import { shouldProcessMessage } from "../../ui/notifications.js";

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
                shouldProcessMessage(msg({ type: "nudge" }), "a1", "s1"),
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
                    msg({ type: "nudge", from: "a2" }),
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
                    msg({ type: "nudge", from: "a2", swarm: "other" }),
                    "a1",
                    "mine",
                ),
                true,
            );
        });
    });
});
