import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as feed from "../extensions/channels/feed.js";

describe("feed", () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "feed-test-"));
    });

    afterEach(() => {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it("appends and reads events", () => {
        feed.appendEvent(tmpDir, "join", "Alpha", "Joined mesh");
        feed.appendEvent(tmpDir, "message", "Alpha", "Hello world");

        const events = feed.readEvents(tmpDir);
        assert.equal(events.length, 2);
        assert.equal(events[0]!.type, "join");
        assert.equal(events[0]!.agent, "Alpha");
        assert.equal(events[1]!.type, "message");
    });

    it("respects limit on read", () => {
        for (let i = 0; i < 10; i++) {
            feed.appendEvent(tmpDir, "edit", "Alpha", `Edit ${i}`);
        }

        const events = feed.readEvents(tmpDir, 3);
        assert.equal(events.length, 3);
        // Should be the last 3
        assert.equal(events[0]!.detail, "Edit 7");
    });

    it("prunes events to retention", () => {
        for (let i = 0; i < 10; i++) {
            feed.appendEvent(tmpDir, "edit", "Alpha", `Edit ${i}`);
        }

        feed.pruneEvents(tmpDir, 5);
        const events = feed.readEvents(tmpDir, 100);
        assert.equal(events.length, 5);
        assert.equal(events[0]!.detail, "Edit 5");
    });

    it("returns empty array for non-existent feed", () => {
        const events = feed.readEvents("/nonexistent/path");
        assert.deepEqual(events, []);
    });

    it("prune on non-existent feed is no-op", () => {
        // Should not throw
        feed.pruneEvents("/nonexistent/path", 10);
    });
});
