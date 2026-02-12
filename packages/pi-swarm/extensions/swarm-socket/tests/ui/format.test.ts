/**
 * Tests for ui/format.ts
 *
 * Verifies tool call formatting, usage stats formatting,
 * path shortening, and getFinalOutput (including thinking model edge case).
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as os from "node:os";
import type { Message } from "@mariozechner/pi-ai";
import {
    shortenPath,
    formatUsageStats,
    formatToolCall,
    getFinalOutput,
    getDisplayItems,
    type UsageStats,
} from "../../ui/format.js";

// ─── Helpers ─────────────────────────────────────────────────────────

/** Identity theme function — returns text without styling for testability. */
const plainFg = (_color: string, text: string) => text;

function makeAssistantMessage(content: Array<{ type: string; text?: string; thinking?: string }>): Message {
    return {
        role: "assistant",
        content: content as any,
    } as Message;
}

// ─── shortenPath ─────────────────────────────────────────────────────

describe("shortenPath", () => {
    it("replaces home directory with ~", () => {
        const home = os.homedir();
        assert.equal(shortenPath(`${home}/projects/test`), "~/projects/test");
    });

    it("leaves non-home paths unchanged", () => {
        assert.equal(shortenPath("/tmp/test/file.ts"), "/tmp/test/file.ts");
    });

    it("handles home directory itself", () => {
        const home = os.homedir();
        assert.equal(shortenPath(home), "~");
    });
});

// ─── formatUsageStats ────────────────────────────────────────────────

describe("formatUsageStats", () => {
    it("formats all fields", () => {
        const usage: UsageStats = {
            input: 12500,
            output: 1200,
            cacheRead: 8300,
            cacheWrite: 2100,
            cost: 0.0342,
            contextTokens: 15800,
            turns: 3,
        };
        const result = formatUsageStats(usage, "claude-sonnet-4-5");
        assert.ok(result.includes("3 turns"));
        assert.ok(result.includes("↑13k"));
        assert.ok(result.includes("↓1.2k"));
        assert.ok(result.includes("R8.3k"));
        assert.ok(result.includes("W2.1k"));
        assert.ok(result.includes("$0.0342"));
        assert.ok(result.includes("ctx:16k"));
        assert.ok(result.includes("claude-sonnet-4-5"));
    });

    it("omits zero/missing fields", () => {
        const usage: UsageStats = {
            input: 500,
            output: 200,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            contextTokens: 0,
            turns: 1,
        };
        const result = formatUsageStats(usage);
        assert.ok(result.includes("1 turn"));
        assert.ok(result.includes("↑500"));
        assert.ok(result.includes("↓200"));
        assert.ok(!result.includes("R"));
        assert.ok(!result.includes("W"));
        assert.ok(!result.includes("$"));
        assert.ok(!result.includes("ctx:"));
    });

    it("formats large token counts with M suffix", () => {
        const usage: UsageStats = {
            input: 1500000,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
        };
        const result = formatUsageStats(usage);
        assert.ok(result.includes("↑1.5M"));
    });

    it("singular turn", () => {
        const usage: UsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 };
        assert.ok(formatUsageStats(usage).includes("1 turn"));
        assert.ok(!formatUsageStats(usage).includes("turns"));
    });

    it("returns empty string for all-zero stats", () => {
        const usage: UsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
        assert.equal(formatUsageStats(usage), "");
    });
});

// ─── formatToolCall ──────────────────────────────────────────────────

describe("formatToolCall", () => {
    it("formats bash with $ prefix", () => {
        const result = formatToolCall("bash", { command: "ls -la" }, plainFg);
        assert.ok(result.includes("$ "));
        assert.ok(result.includes("ls -la"));
    });

    it("truncates long bash commands", () => {
        const longCmd = "a".repeat(100);
        const result = formatToolCall("bash", { command: longCmd }, plainFg);
        assert.ok(result.includes("..."));
        assert.ok(result.length < 100);
    });

    it("formats read with path", () => {
        const result = formatToolCall("read", { path: "/tmp/test.ts" }, plainFg);
        assert.ok(result.includes("read "));
        assert.ok(result.includes("/tmp/test.ts"));
    });

    it("formats read with offset and limit", () => {
        const result = formatToolCall("read", { path: "/tmp/test.ts", offset: 10, limit: 20 }, plainFg);
        assert.ok(result.includes(":10-29"));
    });

    it("formats read with offset only", () => {
        const result = formatToolCall("read", { path: "/tmp/test.ts", offset: 5 }, plainFg);
        assert.ok(result.includes(":5"));
    });

    it("shortens home paths in read", () => {
        const home = os.homedir();
        const result = formatToolCall("read", { path: `${home}/project/file.ts` }, plainFg);
        assert.ok(result.includes("~/project/file.ts"));
    });

    it("formats write with line count", () => {
        const result = formatToolCall("write", { path: "/tmp/out.ts", content: "a\nb\nc\n" }, plainFg);
        assert.ok(result.includes("write "));
        assert.ok(result.includes("(3 lines)"));
    });

    it("formats edit with path", () => {
        const result = formatToolCall("edit", { path: "/tmp/file.ts" }, plainFg);
        assert.ok(result.includes("edit "));
        assert.ok(result.includes("/tmp/file.ts"));
    });

    it("formats ls", () => {
        const result = formatToolCall("ls", { path: "/tmp" }, plainFg);
        assert.ok(result.includes("ls "));
        assert.ok(result.includes("/tmp"));
    });

    it("formats find with pattern", () => {
        const result = formatToolCall("find", { pattern: "*.ts", path: "/tmp" }, plainFg);
        assert.ok(result.includes("find "));
        assert.ok(result.includes("*.ts"));
        assert.ok(result.includes("/tmp"));
    });

    it("formats grep with pattern", () => {
        const result = formatToolCall("grep", { pattern: "TODO", path: "/tmp" }, plainFg);
        assert.ok(result.includes("grep "));
        assert.ok(result.includes("/TODO/"));
        assert.ok(result.includes("/tmp"));
    });

    it("formats unknown tools with name and args preview", () => {
        const result = formatToolCall("custom_tool", { foo: "bar" }, plainFg);
        assert.ok(result.includes("custom_tool"));
        assert.ok(result.includes("foo"));
    });

    it("handles file_path as alternate arg name", () => {
        const result = formatToolCall("read", { file_path: "/tmp/alt.ts" }, plainFg);
        assert.ok(result.includes("/tmp/alt.ts"));
    });
});

// ─── getFinalOutput ──────────────────────────────────────────────────

describe("getFinalOutput", () => {
    it("returns last assistant text", () => {
        const messages: Message[] = [
            makeAssistantMessage([{ type: "text", text: "first response" }]),
            makeAssistantMessage([{ type: "text", text: "final response" }]),
        ];
        assert.equal(getFinalOutput(messages), "final response");
    });

    it("returns empty string for no messages", () => {
        assert.equal(getFinalOutput([]), "");
    });

    it("skips non-assistant messages", () => {
        const messages: Message[] = [
            makeAssistantMessage([{ type: "text", text: "assistant says" }]),
            { role: "user", content: [{ type: "text", text: "user says" }] } as Message,
        ];
        assert.equal(getFinalOutput(messages), "assistant says");
    });

    it("handles thinking model edge case — skips empty/whitespace text parts", () => {
        // Thinking models put "\n\n" as the first text part, then thinking, then actual text
        const messages: Message[] = [
            makeAssistantMessage([
                { type: "text", text: "\n\n" },
                { type: "thinking", thinking: "let me think..." },
                { type: "text", text: "The actual answer is 42." },
            ]),
        ];
        assert.equal(getFinalOutput(messages), "The actual answer is 42.");
    });

    it("returns last non-empty text part when multiple exist", () => {
        const messages: Message[] = [
            makeAssistantMessage([
                { type: "text", text: "first part" },
                { type: "text", text: "" },
                { type: "text", text: "last part" },
            ]),
        ];
        assert.equal(getFinalOutput(messages), "last part");
    });

    it("skips assistant messages with only whitespace text", () => {
        const messages: Message[] = [
            makeAssistantMessage([{ type: "text", text: "good response" }]),
            makeAssistantMessage([{ type: "text", text: "  \n  " }]),
        ];
        assert.equal(getFinalOutput(messages), "good response");
    });
});

// ─── getDisplayItems ─────────────────────────────────────────────────

describe("getDisplayItems", () => {
    it("extracts text and tool calls from assistant messages", () => {
        const messages: Message[] = [
            makeAssistantMessage([
                { type: "text", text: "Thinking..." },
                { type: "toolCall", name: "bash", arguments: { command: "ls" } } as any,
            ]),
        ];
        const items = getDisplayItems(messages);
        assert.equal(items.length, 2);
        assert.equal(items[0].type, "text");
        assert.equal(items[1].type, "toolCall");
        if (items[1].type === "toolCall") {
            assert.equal(items[1].name, "bash");
        }
    });

    it("skips non-assistant messages", () => {
        const messages: Message[] = [
            { role: "user", content: [{ type: "text", text: "user input" }] } as Message,
        ];
        assert.equal(getDisplayItems(messages).length, 0);
    });

    it("returns empty array for empty messages", () => {
        assert.deepEqual(getDisplayItems([]), []);
    });
});
