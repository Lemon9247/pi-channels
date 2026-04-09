import { describe, it, beforeEach } from "node:test";
import * as assert from "node:assert/strict";
import * as registry from "../extensions/channels/registry.js";

describe("registry", () => {
    describe("computeStatus", () => {
        it("returns active for recent activity", () => {
            const now = new Date().toISOString();
            assert.equal(registry.computeStatus(now), "active");
        });

        it("returns idle for 1 minute inactivity", () => {
            const ago = new Date(Date.now() - 60_000).toISOString();
            assert.equal(registry.computeStatus(ago), "idle");
        });

        it("returns away for 6 minutes inactivity", () => {
            const ago = new Date(Date.now() - 360_000).toISOString();
            assert.equal(registry.computeStatus(ago), "away");
        });
    });

    describe("isPidAlive", () => {
        it("returns true for current process", () => {
            assert.equal(registry.isPidAlive(process.pid), true);
        });

        it("returns false for a non-existent PID", () => {
            assert.equal(registry.isPidAlive(99_999_999), false);
        });
    });

    describe("local activity tracking", () => {
        beforeEach(() => {
            registry.resetActivity();
        });

        it("records activity and increments tool count", () => {
            assert.equal(registry.getToolCount(), 0);
            registry.recordActivity("editing");
            assert.equal(registry.getToolCount(), 1);
            assert.equal(registry.getCurrentActivity(), "editing");
        });

        it("clears current activity", () => {
            registry.recordActivity("editing");
            registry.clearActivity();
            assert.equal(registry.getCurrentActivity(), "");
        });

        it("rate-limits auto status", () => {
            assert.equal(registry.canSendAutoStatus(), true);
            assert.equal(registry.canSendAutoStatus(), false);
        });
    });
});
