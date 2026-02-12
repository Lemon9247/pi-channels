/**
 * Tests for ui/activity.ts
 *
 * Verifies enriched activity events, usage accumulation,
 * getAgentUsage, getAggregateUsage, and clearActivity.
 */

import { describe, it, beforeEach } from "node:test";
import * as assert from "node:assert/strict";
import { Readable } from "node:stream";
import {
    getAgentActivity,
    getAllActivity,
    getAgentUsage,
    getAggregateUsage,
    clearActivity,
    pushSyntheticEvent,
    trackAgentOutput,
} from "../../ui/activity.js";

// Helper: create a readable stream that emits lines
function mockStdout(lines: string[]): NodeJS.ReadableStream {
    const stream = new Readable({ read() {} });
    // Push all lines as a single chunk (newline-delimited)
    process.nextTick(() => {
        stream.push(lines.join("\n") + "\n");
        stream.push(null);
    });
    return stream;
}

// Helper: wait for stream to finish processing
function waitForStream(stream: NodeJS.ReadableStream): Promise<void> {
    return new Promise((resolve) => {
        stream.on("close", () => {
            // Small delay to let parseJsonEvent process the buffer
            setTimeout(resolve, 10);
        });
    });
}

// JSON event helpers
function toolStartEvent(toolName: string, args?: Record<string, unknown>) {
    return JSON.stringify({ type: "tool_execution_start", toolName, args });
}

function toolEndEvent(toolName: string, isError = false, result?: string) {
    return JSON.stringify({ type: "tool_execution_end", toolName, isError, result });
}

function messageEndEvent(text: string, usage?: {
    input?: number; output?: number;
    cacheRead?: number; cacheWrite?: number;
    cost?: { total: number };
    totalTokens?: number;
}) {
    return JSON.stringify({
        type: "message_end",
        message: {
            role: "assistant",
            content: [{ type: "text", text }],
            usage,
            model: "claude-sonnet-4-5-20250514",
        },
    });
}

function thinkingMessageEndEvent(thinking: string, text: string, usage?: {
    input?: number; output?: number;
    cost?: { total: number };
    totalTokens?: number;
}) {
    return JSON.stringify({
        type: "message_end",
        message: {
            role: "assistant",
            content: [
                { type: "thinking", thinking },
                { type: "text", text },
            ],
            usage,
        },
    });
}

describe("activity", () => {
    beforeEach(() => {
        clearActivity();
    });

    describe("event storage (no ring buffer cap)", () => {
        it("stores all events without capping", async () => {
            // Push more than the old MAX_EVENTS_PER_AGENT (30)
            const lines: string[] = [];
            for (let i = 0; i < 50; i++) {
                lines.push(toolStartEvent("bash", { command: `echo ${i}` }));
            }

            const stream = mockStdout(lines);
            trackAgentOutput("a1", stream);
            await waitForStream(stream);

            const events = getAgentActivity("a1");
            assert.equal(events.length, 50);
            assert.equal(events[0].summary, "bash echo 0");
            assert.equal(events[49].summary, "bash echo 49");
        });

        it("returns empty array for unknown agent", () => {
            assert.deepEqual(getAgentActivity("nonexistent"), []);
        });
    });

    describe("enriched event data", () => {
        it("tool_start has structured toolName and toolArgs", async () => {
            const stream = mockStdout([
                toolStartEvent("read", { path: "/home/test/file.ts" }),
            ]);
            trackAgentOutput("a1", stream);
            await waitForStream(stream);

            const events = getAgentActivity("a1");
            assert.equal(events.length, 1);
            assert.equal(events[0].type, "tool_start");
            assert.equal(events[0].toolName, "read");
            assert.deepEqual(events[0].toolArgs, { path: "/home/test/file.ts" });
        });

        it("tool_end has structured toolName, isError, and toolResult", async () => {
            const stream = mockStdout([
                toolEndEvent("bash", true, "command not found"),
            ]);
            trackAgentOutput("a1", stream);
            await waitForStream(stream);

            const events = getAgentActivity("a1");
            assert.equal(events.length, 1);
            assert.equal(events[0].type, "tool_end");
            assert.equal(events[0].toolName, "bash");
            assert.equal(events[0].isError, true);
            assert.equal(events[0].toolResult, "command not found");
        });

        it("tool_end isError is false for success", async () => {
            const stream = mockStdout([
                toolEndEvent("read"),
            ]);
            trackAgentOutput("a1", stream);
            await waitForStream(stream);

            const events = getAgentActivity("a1");
            assert.equal(events[0].isError, false);
        });

        it("tool_end truncates result to 8192 chars", async () => {
            const longResult = "x".repeat(10000);
            const stream = mockStdout([
                toolEndEvent("bash", false, longResult),
            ]);
            trackAgentOutput("a1", stream);
            await waitForStream(stream);

            const events = getAgentActivity("a1");
            assert.equal(events[0].toolResult!.length, 8192);
        });

        it("message event has messageText and tokens", async () => {
            const stream = mockStdout([
                messageEndEvent("Hello, this is the full text response.", {
                    input: 1000,
                    output: 200,
                    cost: { total: 0.005 },
                }),
            ]);
            trackAgentOutput("a1", stream);
            await waitForStream(stream);

            const events = getAgentActivity("a1");
            assert.equal(events.length, 1);
            assert.equal(events[0].type, "message");
            assert.equal(events[0].messageText, "Hello, this is the full text response.");
            assert.deepEqual(events[0].tokens, { input: 1000, output: 200 });
        });

        it("thinking event has tokens from usage", async () => {
            const stream = mockStdout([
                thinkingMessageEndEvent("deep thought", "result text", {
                    input: 500,
                    output: 100,
                }),
            ]);
            trackAgentOutput("a1", stream);
            await waitForStream(stream);

            const events = getAgentActivity("a1");
            // thinking comes first, then message (2 events from one message_end)
            assert.equal(events.length, 2);
            assert.equal(events[0].type, "thinking");
            assert.equal(events[0].summary, "deep thought");
            assert.deepEqual(events[0].tokens, { input: 500, output: 100 });
            assert.equal(events[1].type, "message");
            assert.equal(events[1].messageText, "result text");
            assert.deepEqual(events[1].tokens, { input: 500, output: 100 });
        });

        it("caps messageText at 4096 chars", async () => {
            const longText = "x".repeat(8000);
            const stream = mockStdout([
                messageEndEvent(longText, { input: 100, output: 50 }),
            ]);
            trackAgentOutput("a1", stream);
            await waitForStream(stream);

            const events = getAgentActivity("a1");
            assert.equal(events[0].messageText!.length, 4096);
        });
    });

    describe("usage accumulation", () => {
        it("accumulates usage across multiple message_end events", async () => {
            const stream = mockStdout([
                messageEndEvent("Turn 1", {
                    input: 1000, output: 200,
                    cacheRead: 500, cacheWrite: 100,
                    cost: { total: 0.01 },
                    totalTokens: 1200,
                }),
                messageEndEvent("Turn 2", {
                    input: 2000, output: 400,
                    cacheRead: 1000, cacheWrite: 200,
                    cost: { total: 0.02 },
                    totalTokens: 3600,
                }),
            ]);
            trackAgentOutput("a1", stream);
            await waitForStream(stream);

            const usage = getAgentUsage("a1");
            assert.equal(usage.input, 3000);
            assert.equal(usage.output, 600);
            assert.equal(usage.cacheRead, 1500);
            assert.equal(usage.cacheWrite, 300);
            assert.equal(usage.cost, 0.03);
            assert.equal(usage.turns, 2);
            // contextTokens is last seen, not accumulated
            assert.equal(usage.contextTokens, 3600);
        });

        it("returns empty usage for unknown agent", () => {
            const usage = getAgentUsage("nonexistent");
            assert.equal(usage.input, 0);
            assert.equal(usage.output, 0);
            assert.equal(usage.cost, 0);
            assert.equal(usage.turns, 0);
        });

        it("handles missing usage fields gracefully", async () => {
            const stream = mockStdout([
                messageEndEvent("No usage", undefined),
            ]);
            trackAgentOutput("a1", stream);
            await waitForStream(stream);

            const usage = getAgentUsage("a1");
            assert.equal(usage.input, 0);
            assert.equal(usage.turns, 0);
        });
    });

    describe("getAggregateUsage", () => {
        it("sums usage across all agents", async () => {
            const s1 = mockStdout([
                messageEndEvent("A1 turn", {
                    input: 1000, output: 200,
                    cacheRead: 0, cacheWrite: 0,
                    cost: { total: 0.01 },
                }),
            ]);
            trackAgentOutput("a1", s1);
            await waitForStream(s1);

            const s2 = mockStdout([
                messageEndEvent("A2 turn", {
                    input: 2000, output: 400,
                    cacheRead: 0, cacheWrite: 0,
                    cost: { total: 0.02 },
                }),
            ]);
            trackAgentOutput("a2", s2);
            await waitForStream(s2);

            const aggregate = getAggregateUsage();
            assert.equal(aggregate.input, 3000);
            assert.equal(aggregate.output, 600);
            assert.equal(aggregate.cost, 0.03);
            assert.equal(aggregate.turns, 2);
        });

        it("returns zeros when no agents have usage", () => {
            const aggregate = getAggregateUsage();
            assert.equal(aggregate.input, 0);
            assert.equal(aggregate.cost, 0);
        });
    });

    describe("clearActivity", () => {
        it("clears specific agent activity and usage", async () => {
            const s1 = mockStdout([
                messageEndEvent("A1", { input: 100, output: 50, cost: { total: 0.01 } }),
            ]);
            trackAgentOutput("a1", s1);
            await waitForStream(s1);

            const s2 = mockStdout([
                messageEndEvent("A2", { input: 200, output: 100, cost: { total: 0.02 } }),
            ]);
            trackAgentOutput("a2", s2);
            await waitForStream(s2);

            clearActivity("a1");

            assert.deepEqual(getAgentActivity("a1"), []);
            assert.equal(getAgentUsage("a1").input, 0);
            // a2 still intact
            assert.ok(getAgentActivity("a2").length > 0);
            assert.equal(getAgentUsage("a2").input, 200);
        });

        it("clears all agents when no name given", async () => {
            const stream = mockStdout([
                messageEndEvent("test", { input: 100, output: 50, cost: { total: 0.01 } }),
            ]);
            trackAgentOutput("a1", stream);
            await waitForStream(stream);

            clearActivity();

            assert.equal(getAllActivity().size, 0);
            assert.equal(getAgentUsage("a1").input, 0);
        });
    });

    describe("synthetic events", () => {
        it("pushSyntheticEvent adds to activity feed", () => {
            pushSyntheticEvent("a1", "message", "agent registered");
            pushSyntheticEvent("a1", "message", "agent completed");

            const events = getAgentActivity("a1");
            assert.equal(events.length, 2);
            assert.equal(events[0].summary, "agent registered");
            assert.equal(events[1].summary, "agent completed");
        });
    });

    describe("edge cases", () => {
        it("non-JSON lines are silently skipped", async () => {
            const stream = mockStdout([
                "some debug output",
                toolStartEvent("bash", { command: "ls" }),
                "WARNING: something happened",
                toolEndEvent("bash"),
            ]);
            trackAgentOutput("a1", stream);
            await waitForStream(stream);

            const events = getAgentActivity("a1");
            assert.equal(events.length, 2);
            assert.equal(events[0].type, "tool_start");
            assert.equal(events[1].type, "tool_end");
        });

        it("tool_execution_start with missing args", async () => {
            const stream = mockStdout([
                JSON.stringify({ type: "tool_execution_start", toolName: "custom_tool" }),
            ]);
            trackAgentOutput("a1", stream);
            await waitForStream(stream);

            const events = getAgentActivity("a1");
            assert.equal(events.length, 1);
            assert.equal(events[0].toolName, "custom_tool");
            assert.equal(events[0].toolArgs, undefined);
            assert.equal(events[0].summary, "custom_tool");
        });
    });

    describe("tool summary formatting", () => {
        it("formats bash command summary", async () => {
            const stream = mockStdout([
                toolStartEvent("bash", { command: "ls -la" }),
            ]);
            trackAgentOutput("a1", stream);
            await waitForStream(stream);

            assert.equal(getAgentActivity("a1")[0].summary, "bash ls -la");
        });

        it("truncates long bash commands", async () => {
            const longCmd = "echo " + "x".repeat(100);
            const stream = mockStdout([
                toolStartEvent("bash", { command: longCmd }),
            ]);
            trackAgentOutput("a1", stream);
            await waitForStream(stream);

            const summary = getAgentActivity("a1")[0].summary;
            assert.ok(summary.endsWith("…"));
            assert.ok(summary.length <= 60); // "bash " + 50 chars + "…"
        });

        it("formats hive_done summary", async () => {
            const stream = mockStdout([
                toolStartEvent("hive_done", { summary: "finished research" }),
            ]);
            trackAgentOutput("a1", stream);
            await waitForStream(stream);

            assert.equal(getAgentActivity("a1")[0].summary, 'hive_done "finished research"');
        });

        it("formats edit with shortened path", async () => {
            const stream = mockStdout([
                toolStartEvent("edit", { path: "/some/path/file.ts" }),
            ]);
            trackAgentOutput("a1", stream);
            await waitForStream(stream);

            assert.equal(getAgentActivity("a1")[0].summary, "edit /some/path/file.ts");
        });
    });
});
