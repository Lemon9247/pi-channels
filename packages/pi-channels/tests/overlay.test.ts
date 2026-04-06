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
        // Not visible, so should have unread
        assert.equal(overlay.getTotalUnread(state), 1);
    });

    it("clears unread when focused", () => {
        const state = overlay.createOverlayState();
        overlay.addMessage(state, {
            timestamp: new Date(),
            from: "Alpha",
            text: "hello",
            channel: "general",
            isDM: false,
        }, "TestAgent");

        state.visible = true;
        state.focusedChannel = "general";
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
        assert.equal(state.focusedChannel, "all"); // wraps around
    });

    it("filters visible messages by channel", () => {
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

        // All
        assert.equal(overlay.getVisibleMessages(state).length, 2);

        // Filter to testing
        state.focusedChannel = "testing";
        const visible = overlay.getVisibleMessages(state);
        assert.equal(visible.length, 1);
        assert.equal(visible[0]!.text, "on testing");
    });

    it("renders status bar", () => {
        const bar = overlay.renderStatusBar("CozyBadger", 3, 2);
        assert.ok(bar.includes("CozyBadger"));
        assert.ok(bar.includes("3 peers"));
        assert.ok(bar.includes("2 unread"));
    });

    it("renders status bar without unread", () => {
        const bar = overlay.renderStatusBar("CozyBadger", 1, 0);
        assert.ok(!bar.includes("unread"));
    });

    it("parseInput detects DM", () => {
        const result = overlay.parseInput("@Alpha hello there");
        assert.deepEqual(result, { type: "dm", target: "Alpha", message: "hello there" });
    });

    it("parseInput detects channel message", () => {
        const result = overlay.parseInput("hello everyone");
        assert.deepEqual(result, { type: "channel", message: "hello everyone" });
    });

    it("renders overlay string", () => {
        const state = overlay.createOverlayState();
        state.visible = true;
        overlay.addMessage(state, {
            timestamp: new Date(),
            from: "Alpha",
            text: "hello",
            channel: "general",
            isDM: false,
        }, "TestAgent");

        const rendered = overlay.renderOverlay(state, {
            width: 60,
            height: 15,
            agentName: "Beta",
            members: ["Alpha", "Beta"],
            channels: ["general"],
            projectName: "my-project",
        });

        assert.ok(rendered.includes("my-project"));
        assert.ok(rendered.includes("Alpha"));
        assert.ok(rendered.includes("hello"));
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
        assert.equal(state.messages[0]!.text, "msg 5"); // oldest kept
    });
});
