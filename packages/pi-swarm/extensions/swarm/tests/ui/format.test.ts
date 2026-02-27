/**
 * Tests for ui/format.ts
 *
 * Verifies usage stats formatting and path shortening.
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as os from "node:os";
import {
    shortenPath,
    formatUsageStats,
    statusIcon,
    shortModelName,
    type UsageStats,
} from "../../ui/format.js";

// ─── statusIcon ──────────────────────────────────────────────────────

describe("statusIcon", () => {
    it("returns 💤 for idle status", () => {
        assert.equal(statusIcon("idle"), "💤");
    });

    it("returns ⏳ for running status", () => {
        assert.equal(statusIcon("running"), "⏳");
    });

    it("returns ✓ for done status", () => {
        assert.equal(statusIcon("done"), "✓");
    });

    it("returns ? for unknown status", () => {
        assert.equal(statusIcon("unknown" as any), "?");
    });
});

// ─── shortModelName ──────────────────────────────────────────────────

describe("shortModelName", () => {
    it("strips claude- prefix and date suffix", () => {
        assert.equal(shortModelName("claude-haiku-4-5-20250514"), "haiku-4-5");
        assert.equal(shortModelName("claude-sonnet-4-5-20250514"), "sonnet-4-5");
        assert.equal(shortModelName("claude-opus-4-5-20241231"), "opus-4-5");
    });

    it("strips claude- prefix when no date suffix", () => {
        assert.equal(shortModelName("claude-sonnet-4-5"), "sonnet-4-5");
        assert.equal(shortModelName("claude-haiku"), "haiku");
    });

    it("strips date suffix when no claude- prefix", () => {
        assert.equal(shortModelName("custom-model-20250514"), "custom-model");
    });

    it("returns model as-is if no prefix or suffix to strip", () => {
        assert.equal(shortModelName("gpt-4"), "gpt-4");
        assert.equal(shortModelName("unknown-model"), "unknown-model");
    });

    it("returns undefined for undefined input", () => {
        assert.equal(shortModelName(undefined), undefined);
    });

    it("handles empty string", () => {
        assert.equal(shortModelName(""), "");
    });

    it("only strips 8-digit date suffixes", () => {
        assert.equal(shortModelName("claude-model-2025"), "claude-model-2025");
        assert.equal(shortModelName("claude-model-202505"), "claude-model-202505");
        assert.equal(shortModelName("claude-model-20250514"), "model");
    });
});

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

