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
    type UsageStats,
} from "../../ui/format.js";

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

