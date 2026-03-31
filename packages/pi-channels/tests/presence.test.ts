import { describe, it, beforeEach } from "node:test";
import * as assert from "node:assert/strict";
import * as presence from "../extensions/channels/presence.js";

describe("presence", () => {
    beforeEach(() => {
        presence.reset();
    });

    it("records activity and increments tool count", () => {
        assert.equal(presence.getToolCount(), 0);
        presence.recordActivity("editing");
        assert.equal(presence.getToolCount(), 1);
        assert.equal(presence.getCurrentActivity(), "editing");
    });

    it("clears activity", () => {
        presence.recordActivity("editing");
        presence.clearActivity();
        assert.equal(presence.getCurrentActivity(), "");
    });

    it("tracks idle time", () => {
        presence.recordActivity();
        const idle = presence.getIdleMs();
        assert.ok(idle < 100, `Idle should be ~0ms right after activity, got ${idle}`);
    });

    it("rate-limits auto-status", () => {
        assert.equal(presence.canSendAutoStatus(), true);
        // Second call within 30s should be false
        assert.equal(presence.canSendAutoStatus(), false);
    });
});
