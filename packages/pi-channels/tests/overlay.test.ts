import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as overlay from "../extensions/channels/overlay.js";

describe("overlay", () => {
    it("creates initial state", () => {
        const state = overlay.createOverlayState();
        assert.equal(state.visible, false);
        assert.equal(state.messages.length, 0);
        assert.equal(state.focusedChannel, "all");
        assert.equal(state.inputBuffer, "");
    });

    it("adds messages and tracks unread", () => {
        const state = overlay.createOverlayState();
        overlay.addMessage(state, {
            timestamp: new Date(),
            from: "Alpha",
            text: "hello",
            channel: "general",
            isDM: false,
        }, "TestAgent");

        assert.equal(state.messages.length, 1);
        assert.equal(overlay.getTotalUnread(state), 1);
    });

    it("tracks DM unread separately", () => {
        const state = overlay.createOverlayState();
        overlay.addMessage(state, {
            timestamp: new Date(),
            from: "Alpha",
            text: "psst",
            channel: "dm",
            isDM: true,
        }, "TestAgent");

        assert.equal(overlay.getTotalUnread(state), 1);
        state.focusedChannel = "dm";
        overlay.clearFocusedUnread(state);
        assert.equal(overlay.getTotalUnread(state), 0);
    });

    it("cycles channels", () => {
        const state = overlay.createOverlayState();
        const channels = ["general", "testing"];

        assert.equal(state.focusedChannel, "all");
        overlay.cycleChannel(state, channels);
        assert.equal(state.focusedChannel, "general");
        overlay.cycleChannel(state, channels);
        assert.equal(state.focusedChannel, "testing");
        overlay.cycleChannel(state, channels);
        assert.equal(state.focusedChannel, "dm");
        overlay.cycleChannel(state, channels);
        assert.equal(state.focusedChannel, "all");
    });

    it("filters visible messages by current focus", () => {
        const state = overlay.createOverlayState();
        overlay.addMessage(state, {
            timestamp: new Date(),
            from: "Alpha",
            text: "on general",
            channel: "general",
            isDM: false,
        }, "TestAgent");
        overlay.addMessage(state, {
            timestamp: new Date(),
            from: "Beta",
            text: "on testing",
            channel: "testing",
            isDM: false,
        }, "TestAgent");
        overlay.addMessage(state, {
            timestamp: new Date(),
            from: "Gamma",
            text: "in dm",
            channel: "dm",
            isDM: true,
        }, "TestAgent");

        assert.equal(overlay.getVisibleMessages(state).length, 3);
        state.focusedChannel = "testing";
        assert.equal(overlay.getVisibleMessages(state).length, 1);
        state.focusedChannel = "dm";
        assert.equal(overlay.getVisibleMessages(state).length, 1);
    });

    it("stores and navigates message history", () => {
        const state = overlay.createOverlayState();
        overlay.addToHistory(state, "first");
        overlay.addToHistory(state, "second");

        assert.equal(overlay.navigateHistory(state, -1), "second");
        assert.equal(overlay.navigateHistory(state, -1), "first");
        assert.equal(overlay.navigateHistory(state, 1), "second");
    });

    it("parseInput detects DMs", () => {
        const result = overlay.parseInput("@Alpha hello there");
        assert.deepEqual(result, { type: "dm", target: "Alpha", message: "hello there" });
    });

    it("parseInput detects channel messages", () => {
        const result = overlay.parseInput("hello everyone");
        assert.deepEqual(result, { type: "channel", message: "hello everyone" });
    });

    it("caps messages at maxMessages", () => {
        const state = overlay.createOverlayState();
        state.maxMessages = 5;

        for (let i = 0; i < 10; i++) {
            overlay.addMessage(state, {
                timestamp: new Date(),
                from: "Alpha",
                text: `msg ${i}`,
                channel: "general",
                isDM: false,
            }, "TestAgent");
        }

        assert.equal(state.messages.length, 5);
        assert.equal(state.messages[0]!.text, "msg 5");
    });
});
