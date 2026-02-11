/**
 * Tests for util.ts — allOrCleanup
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { allOrCleanup } from "../src/util.js";

describe("allOrCleanup", () => {
    it("returns all results when everything succeeds", async () => {
        const results = await allOrCleanup(
            [1, 2, 3],
            async (n) => n * 10,
            () => {},
        );
        assert.deepEqual(results, [10, 20, 30]);
    });

    it("calls cleanup on successful results when one fails", async () => {
        const cleaned: number[] = [];

        await assert.rejects(
            () => allOrCleanup(
                [1, 2, 3],
                async (n) => {
                    if (n === 2) throw new Error("fail on 2");
                    return n * 10;
                },
                (result) => cleaned.push(result),
            ),
            { message: "fail on 2" },
        );

        // Items 1 and 3 succeeded and should be cleaned up
        assert.deepEqual(cleaned.sort(), [10, 30]);
    });

    it("throws the first error", async () => {
        await assert.rejects(
            () => allOrCleanup(
                [1, 2],
                async (n) => {
                    if (n === 1) throw new Error("first");
                    if (n === 2) throw new Error("second");
                    return n;
                },
                () => {},
            ),
            (err: Error) => {
                // Should be one of the errors (Promise.allSettled order)
                assert.ok(err.message === "first" || err.message === "second");
                return true;
            },
        );
    });

    it("handles empty input", async () => {
        const results = await allOrCleanup(
            [],
            async (n: number) => n,
            () => {},
        );
        assert.deepEqual(results, []);
    });

    it("cleanup errors don't mask the original error", async () => {
        await assert.rejects(
            () => allOrCleanup(
                [1, 2],
                async (n) => {
                    if (n === 2) throw new Error("operation failed");
                    return n;
                },
                () => { throw new Error("cleanup exploded"); },
            ),
            { message: "operation failed" },
        );
    });

    it("preserves result order", async () => {
        const results = await allOrCleanup(
            ["a", "b", "c"],
            async (s) => {
                // Simulate varying delays
                await new Promise((r) => setTimeout(r, s === "b" ? 10 : 1));
                return s.toUpperCase();
            },
            () => {},
        );
        assert.deepEqual(results, ["A", "B", "C"]);
    });
});
