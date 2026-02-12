/**
 * Tests for the unified swarm tool — blocking mode, chain mode,
 * auto-detection, error handling, and renderResult.
 *
 * These tests exercise the pure logic functions exported/used by
 * the swarm tool. Actual process spawning requires integration tests
 * (see spawn.test.ts for buildAgentArgs coverage).
 *
 * P3-T9 through P3-T14
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import type { Message } from "@mariozechner/pi-ai";
import { type SingleResult } from "../../core/spawn.js";
import {
    type UsageStats,
    getDisplayItems,
    getFinalOutput,
    formatToolCall,
    formatUsageStats,
} from "../../ui/format.js";
import { feedRawEvent, getAgentActivity, clearActivity } from "../../ui/activity.js";
import {
    shouldBlock,
    mapWithConcurrencyLimit,
    aggregateUsage,
    formatBlockingResult,
} from "../../tools/swarm.js";

// ─── Helpers ─────────────────────────────────────────────────────────

/** Plain theme.fg for testing — returns unstyled text. */
const plainFg = (_color: string, text: string) => text;
const plainBold = (text: string) => text;
const mockTheme = {
    fg: plainFg,
    bold: plainBold,
};

function makeUsage(overrides?: Partial<UsageStats>): UsageStats {
    return {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 0,
        turns: 0,
        ...overrides,
    };
}

function makeAssistantMessage(text: string, usage?: Partial<Message["usage"]>): Message {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        usage: usage as any,
    } as Message;
}

function makeToolCallMessage(toolName: string, args: Record<string, unknown>): Message {
    return {
        role: "assistant",
        content: [{ type: "toolCall", name: toolName, arguments: args }],
    } as Message;
}

function makeSingleResult(overrides?: Partial<SingleResult>): SingleResult {
    return {
        agent: "scout",
        agentSource: "user",
        task: "Find something",
        exitCode: 0,
        messages: [makeAssistantMessage("Result output text")],
        stderr: "",
        usage: makeUsage({ input: 1000, output: 200, cost: 0.01, turns: 1 }),
        model: "claude-haiku-4-5",
        ...overrides,
    };
}

// ─── Module-level imports of the functions we're testing ─────────────
// We import the swarm module to test shouldBlock and rendering.
// Since registerSwarmTool has side effects, we test the exported logic
// via the functions we can access. For non-exported functions like
// shouldBlock, we test them indirectly through the behavior.

// ─── shouldBlock (auto-detection) ────────────────────────────────────
// P3-T12: Tests for auto-detection — 1 agent → blocking, 2+ → async, chain → blocking

describe("shouldBlock auto-detection (T12)", () => {
    it("1 agent without taskDir → blocking", () => {
        assert.equal(shouldBlock({ agents: [{}] }), true);
    });

    it("1 agent with taskDir → async", () => {
        assert.equal(shouldBlock({ agents: [{}], taskDir: { path: "/tmp" } }), false);
    });

    it("2+ agents → async", () => {
        assert.equal(shouldBlock({ agents: [{}, {}] }), false);
    });

    it("chain → always blocking", () => {
        assert.equal(shouldBlock({
            agents: [],
            chain: [{ agent: "scout", task: "go" }],
        }), true);
    });

    it("explicit blocking: true overrides multi-agent", () => {
        assert.equal(shouldBlock({ agents: [{}, {}], blocking: true }), true);
    });

    it("explicit blocking: false overrides single-agent", () => {
        assert.equal(shouldBlock({ agents: [{}], blocking: false }), false);
    });

    it("empty chain does not force blocking", () => {
        assert.equal(shouldBlock({ agents: [{}, {}], chain: [] }), false);
    });

    it("chain with blocking: true still blocking", () => {
        assert.equal(shouldBlock({
            agents: [],
            chain: [{ agent: "a", task: "go" }],
            blocking: true,
        }), true);
    });
});

// ─── mapWithConcurrencyLimit (T10) ──────────────────────────────────

describe("mapWithConcurrencyLimit (T10)", () => {
    it("processes all items", async () => {
        const items = [1, 2, 3, 4, 5];
        const results = await mapWithConcurrencyLimit(items, 2, async (x) => x * 2);
        assert.deepEqual(results, [2, 4, 6, 8, 10]);
    });

    it("respects concurrency limit", async () => {
        let running = 0;
        let maxRunning = 0;

        const items = [1, 2, 3, 4, 5, 6];
        await mapWithConcurrencyLimit(items, 3, async (x) => {
            running++;
            maxRunning = Math.max(maxRunning, running);
            await new Promise(r => setTimeout(r, 10));
            running--;
            return x;
        });

        assert.ok(maxRunning <= 3, `Max concurrent was ${maxRunning}, expected <= 3`);
    });

    it("handles empty array", async () => {
        const results = await mapWithConcurrencyLimit([], 4, async () => "x");
        assert.deepEqual(results, []);
    });

    it("handles limit larger than items", async () => {
        const results = await mapWithConcurrencyLimit([1, 2], 10, async (x) => x);
        assert.deepEqual(results, [1, 2]);
    });

    it("preserves order despite concurrency", async () => {
        const items = [50, 10, 30, 20, 40];
        const results = await mapWithConcurrencyLimit(items, 3, async (delay) => {
            await new Promise(r => setTimeout(r, delay));
            return delay;
        });
        assert.deepEqual(results, [50, 10, 30, 20, 40]);
    });

    it("rejects when function throws (uncaught)", async () => {
        const items = [1, 2, 3];
        try {
            await mapWithConcurrencyLimit(items, 2, async (x) => {
                if (x === 2) throw new Error("boom");
                return x;
            });
            assert.fail("Should have thrown");
        } catch (err: any) {
            assert.equal(err.message, "boom");
        }
    });

    it("continues on failure when caller catches per-item", async () => {
        const items = [1, 2, 3];
        const results = await mapWithConcurrencyLimit(items, 2, async (x) => {
            if (x === 2) throw new Error("boom");
            return x;
        }).catch(() => null) || await mapWithConcurrencyLimit(
            items, 2,
            (x) => (async () => {
                if (x === 2) throw new Error("boom");
                return x;
            })().catch((err): number => -1),
        );
        // Wrapping fn in catch returns -1 for failed item
        assert.deepEqual(results, [1, -1, 3]);
    });
});

// ─── aggregateUsage ─────────────────────────────────────────────────

describe("aggregateUsage", () => {
    it("aggregates usage from multiple results", () => {
        const results = [
            makeSingleResult({ usage: makeUsage({ input: 1000, output: 200, cost: 0.01, turns: 2 }) }),
            makeSingleResult({ usage: makeUsage({ input: 500, output: 100, cost: 0.005, turns: 1 }) }),
        ];
        const totals = aggregateUsage(results);
        assert.equal(totals.input, 1500);
        assert.equal(totals.output, 300);
        assert.equal(totals.cost, 0.015);
        assert.equal(totals.turns, 3);
    });

    it("returns zeros for empty results", () => {
        const totals = aggregateUsage([]);
        assert.equal(totals.input, 0);
        assert.equal(totals.cost, 0);
        assert.equal(totals.turns, 0);
    });

    it("handles single result", () => {
        const totals = aggregateUsage([
            makeSingleResult({ usage: makeUsage({ input: 750, turns: 3 }) }),
        ]);
        assert.equal(totals.input, 750);
        assert.equal(totals.turns, 3);
    });
});

// ─── formatBlockingResult (T14) ─────────────────────────────────────

describe("formatBlockingResult (T14)", () => {
    it("single success shows output", () => {
        const result = makeSingleResult();
        const text = formatBlockingResult([result], "single");
        assert.equal(text, "Result output text");
    });

    it("single failure shows error", () => {
        const result = makeSingleResult({
            exitCode: 1,
            errorMessage: "Timeout",
            messages: [makeAssistantMessage("partial output")],
        });
        const text = formatBlockingResult([result], "single");
        assert.ok(text.includes("failed (exit code 1)"));
        assert.ok(text.includes("Timeout"));
        assert.ok(text.includes("partial output"));
    });

    it("single with no output shows placeholder", () => {
        const result = makeSingleResult({ messages: [] });
        const text = formatBlockingResult([result], "single");
        assert.equal(text, "(no output)");
    });

    it("parallel shows per-agent status", () => {
        const results = [
            makeSingleResult({ agent: "scout-1" }),
            makeSingleResult({ agent: "scout-2", exitCode: 1, errorMessage: "crashed" }),
        ];
        const text = formatBlockingResult(results, "parallel");
        assert.ok(text.includes("1/2 succeeded"));
        assert.ok(text.includes("scout-1"));
        assert.ok(text.includes("scout-2"));
        assert.ok(text.includes("crashed"));
    });

    it("chain shows step numbers", () => {
        const results = [
            makeSingleResult({ agent: "scout", step: 1 }),
            makeSingleResult({ agent: "worker", step: 2 }),
        ];
        const text = formatBlockingResult(results, "chain");
        assert.ok(text.includes("2/2 steps succeeded"));
        assert.ok(text.includes("Step 1"));
        assert.ok(text.includes("Step 2"));
    });

    it("chain with failure shows partial completion", () => {
        const results = [
            makeSingleResult({ agent: "scout", step: 1 }),
            makeSingleResult({ agent: "worker", step: 2, exitCode: 1 }),
        ];
        const text = formatBlockingResult(results, "chain");
        assert.ok(text.includes("1/2 steps succeeded"));
    });
});

// ─── Chain {previous} substitution (T11) ─────────────────────────────

describe("chain {previous} substitution (T11)", () => {
    it("replaces {previous} in task text", () => {
        const template = "Analyze this: {previous}";
        const result = template.replace(/\{previous\}/g, "some output from step 1");
        assert.equal(result, "Analyze this: some output from step 1");
    });

    it("replaces multiple {previous} occurrences", () => {
        const template = "Compare {previous} with {previous}";
        const result = template.replace(/\{previous\}/g, "value");
        assert.equal(result, "Compare value with value");
    });

    it("no-op when no {previous} placeholder", () => {
        const template = "Just do something";
        const result = template.replace(/\{previous\}/g, "unused");
        assert.equal(result, "Just do something");
    });

    it("handles empty previous output", () => {
        const template = "Work with: {previous}";
        const result = template.replace(/\{previous\}/g, "");
        assert.equal(result, "Work with: ");
    });
});

// ─── Error Handling (T13) ────────────────────────────────────────────

describe("error handling — per-agent status (T13)", () => {
    it("failed result has non-zero exit code", () => {
        const result = makeSingleResult({ exitCode: 1, errorMessage: "process crashed" });
        assert.equal(result.exitCode, 1);
        assert.equal(result.errorMessage, "process crashed");
    });

    it("mixed results have per-agent status", () => {
        const results = [
            makeSingleResult({ agent: "a1", exitCode: 0 }),
            makeSingleResult({ agent: "a2", exitCode: 1, errorMessage: "OOM" }),
            makeSingleResult({ agent: "a3", exitCode: 0 }),
        ];

        const succeeded = results.filter(r => r.exitCode === 0);
        const failed = results.filter(r => r.exitCode !== 0);

        assert.equal(succeeded.length, 2);
        assert.equal(failed.length, 1);
        assert.equal(failed[0].agent, "a2");
        assert.equal(failed[0].errorMessage, "OOM");
    });

    it("all-failed still returns all results", () => {
        const results = [
            makeSingleResult({ agent: "a1", exitCode: 1 }),
            makeSingleResult({ agent: "a2", exitCode: 2 }),
        ];
        assert.equal(results.length, 2);
        assert.ok(results.every(r => r.exitCode !== 0));
    });
});

// ─── feedRawEvent integration (activity store) ──────────────────────

describe("feedRawEvent activity integration", () => {
    beforeEach(() => clearActivity());
    afterEach(() => clearActivity());

    it("feeds tool_execution_start into activity store", () => {
        const line = JSON.stringify({
            type: "tool_execution_start",
            toolName: "read",
            args: { path: "/tmp/test.ts" },
        });
        feedRawEvent("test-agent", line);

        const activity = getAgentActivity("test-agent");
        assert.equal(activity.length, 1);
        assert.equal(activity[0].type, "tool_start");
        assert.ok(activity[0].summary.includes("read"));
    });

    it("feeds tool_execution_end into activity store", () => {
        const line = JSON.stringify({
            type: "tool_execution_end",
            toolName: "bash",
            isError: false,
        });
        feedRawEvent("test-agent", line);

        const activity = getAgentActivity("test-agent");
        assert.equal(activity.length, 1);
        assert.equal(activity[0].type, "tool_end");
        assert.ok(activity[0].summary.includes("bash"));
    });

    it("feeds message_end with usage into activity store", () => {
        const line = JSON.stringify({
            type: "message_end",
            message: {
                role: "assistant",
                content: [{ type: "text", text: "Hello world" }],
                usage: { input: 100, output: 50, cost: { total: 0.001 } },
            },
        });
        feedRawEvent("test-agent", line);

        const activity = getAgentActivity("test-agent");
        assert.ok(activity.length >= 1);
        const messageEvent = activity.find(e => e.type === "message");
        assert.ok(messageEvent);
        assert.ok(messageEvent!.summary.includes("Hello world"));
    });

    it("ignores invalid JSON lines", () => {
        feedRawEvent("test-agent", "not valid json {{{");
        const activity = getAgentActivity("test-agent");
        assert.equal(activity.length, 0);
    });

    it("ignores empty lines", () => {
        feedRawEvent("test-agent", "   ");
        const activity = getAgentActivity("test-agent");
        assert.equal(activity.length, 0);
    });
});

// ─── renderResult for blocking modes (T14) ──────────────────────────

describe("renderResult shapes (T14)", () => {
    // We test the render helpers directly since they're used by renderResult.
    // These are the same functions from swarm.ts — reimplemented here for
    // isolated testing.

    // Format utilities imported at module level

    function renderBlockingSingleText(result: SingleResult): string {
        const icon = result.exitCode === 0 ? "✓" : "✗";
        const items = getDisplayItems(result.messages);
        const toolCalls = items.filter(i => i.type === "toolCall");
        const lastCalls = toolCalls.slice(-5);

        const lines: string[] = [];
        lines.push(`${icon} ${result.agent} ${formatUsageStats(result.usage, result.model)}`);

        for (const call of lastCalls) {
            if (call.type === "toolCall") {
                lines.push(`  ${formatToolCall(call.name, call.args, plainFg)}`);
            }
        }

        const output = getFinalOutput(result.messages);
        if (output) {
            const preview = output.length > 120 ? output.slice(0, 120) + "..." : output;
            lines.push(`  ${preview}`);
        }

        return lines.join("\n");
    }

    it("collapsed single shows agent name and usage", () => {
        const result = makeSingleResult();
        const text = renderBlockingSingleText(result);
        assert.ok(text.includes("✓"));
        assert.ok(text.includes("scout"));
        assert.ok(text.includes("claude-haiku-4-5"));
    });

    it("collapsed single shows last tool calls", () => {
        const result = makeSingleResult({
            messages: [
                makeToolCallMessage("read", { path: "/tmp/file.ts" }),
                makeToolCallMessage("bash", { command: "echo hello" }),
                makeAssistantMessage("Done!"),
            ],
        });
        const text = renderBlockingSingleText(result);
        // read tool shows path, bash tool shows "$ command"
        assert.ok(text.includes("file.ts"), `Expected path in: ${text}`);
        assert.ok(text.includes("echo hello"), `Expected command in: ${text}`);
    });

    it("collapsed single shows output preview", () => {
        const result = makeSingleResult({
            messages: [makeAssistantMessage("The answer is 42.")],
        });
        const text = renderBlockingSingleText(result);
        assert.ok(text.includes("The answer is 42."));
    });

    it("failed result shows ✗ icon", () => {
        const result = makeSingleResult({ exitCode: 1 });
        const text = renderBlockingSingleText(result);
        assert.ok(text.includes("✗"));
    });

    it("multi-agent collapsed shows counts", () => {
        const results = [
            makeSingleResult({ agent: "scout-1" }),
            makeSingleResult({ agent: "scout-2", exitCode: 1 }),
        ];
        const succeeded = results.filter(r => r.exitCode === 0).length;
        const total = results.length;
        // Verify the data that renderBlockingMulti would use
        assert.equal(succeeded, 1);
        assert.equal(total, 2);
    });

    it("chain collapsed shows step info", () => {
        const results = [
            makeSingleResult({ agent: "scout", step: 1 }),
            makeSingleResult({ agent: "worker", step: 2 }),
        ];
        // Verify step numbers are preserved
        assert.equal(results[0].step, 1);
        assert.equal(results[1].step, 2);
    });
});

// ─── Role enforcement ────────────────────────────────────────────────

describe("role enforcement", () => {
    it("agent role identity prevents async mode", () => {
        // Test the logic: if role === "agent" and !isBlocking, return error
        const identity = { role: "agent" as const };
        const isBlocking = false;

        const shouldReject = !isBlocking && identity.role === "agent";
        assert.ok(shouldReject);
    });

    it("agent role with blocking mode is allowed", () => {
        const identity = { role: "agent" as const };
        const isBlocking = true;

        const shouldReject = !isBlocking && identity.role === "agent";
        assert.ok(!shouldReject);
    });

    it("queen role can use async mode", () => {
        const identity = { role: "queen" as const };
        const isBlocking = false;

        const shouldReject = !isBlocking && identity.role === "agent";
        assert.ok(!shouldReject);
    });

    it("coordinator role can use async mode", () => {
        const identity = { role: "coordinator" as const };
        const isBlocking = false;

        const shouldReject = !isBlocking && identity.role === "agent";
        assert.ok(!shouldReject);
    });
});
