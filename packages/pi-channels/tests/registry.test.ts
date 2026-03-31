import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as registry from "../extensions/channels/registry.js";
import { type RegistryEntry } from "../extensions/channels/types.js";

describe("registry", () => {
    // We'll test computeStatus which doesn't touch files
    describe("computeStatus", () => {
        it("returns active for recent activity", () => {
            const now = new Date().toISOString();
            assert.equal(registry.computeStatus(now, [], 900), "active");
        });

        it("returns idle for 1min inactivity", () => {
            const ago = new Date(Date.now() - 60_000).toISOString();
            assert.equal(registry.computeStatus(ago, [], 900), "idle");
        });

        it("returns away for 6min inactivity without reservations", () => {
            const ago = new Date(Date.now() - 360_000).toISOString();
            assert.equal(registry.computeStatus(ago, [], 900), "away");
        });

        it("returns stuck for long inactivity with reservations", () => {
            const ago = new Date(Date.now() - 1_000_000).toISOString();
            const res = [{
                paths: ["src/auth/"],
                reason: "Working",
                agent: "Alpha",
                timestamp: new Date().toISOString(),
            }];
            assert.equal(registry.computeStatus(ago, res, 900), "stuck");
        });

        it("returns away (not stuck) when under threshold with reservations", () => {
            // 6min idle, stuck threshold 15min
            const ago = new Date(Date.now() - 360_000).toISOString();
            const res = [{
                paths: ["src/auth/"],
                reason: "Working",
                agent: "Alpha",
                timestamp: new Date().toISOString(),
            }];
            assert.equal(registry.computeStatus(ago, res, 900), "away");
        });
    });

    describe("isPidAlive", () => {
        it("returns true for current process", () => {
            assert.equal(registry.isPidAlive(process.pid), true);
        });

        it("returns false for non-existent PID", () => {
            assert.equal(registry.isPidAlive(99999999), false);
        });
    });
});
