/**
 * Tests for ui/overlay.ts — DashboardOverlay component
 *
 * Tests render output for list view, detail view, empty state.
 * Tests keyboard handling: navigation, drill-in, back, close.
 * Tests live refresh behavior.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { Readable } from "node:stream";
import { DashboardOverlay } from "../../ui/overlay.js";
import { setSwarmState, getSwarmState, type SwarmState, type AgentInfo } from "../../core/state.js";
import { clearActivity, pushSyntheticEvent, trackAgentOutput } from "../../ui/activity.js";

// ─── Mocks ──────────────────────────────────────────────────────────

/** Minimal TUI mock — just needs requestRender() */
function mockTui() {
    let renderCount = 0;
    return {
        requestRender(_force?: boolean) { renderCount++; },
        get renderCount() { return renderCount; },
    };
}

/** Minimal theme mock — fg/bg just return the text (no ANSI codes) */
function mockTheme() {
    return {
        fg: (_color: string, text: string) => text,
        bg: (_color: string, text: string) => text,
        bold: (text: string) => text,
    };
}

/** Track if done() was called */
function mockDone() {
    let called = false;
    const fn = () => { called = true; };
    return { fn, get called() { return called; } };
}

/** Set up a swarm state with the given agents */
function setupSwarm(agents: Partial<AgentInfo>[]): void {
    const agentMap = new Map<string, AgentInfo>();
    for (const a of agents) {
        const info: AgentInfo = {
            name: a.name || "test-agent",
            role: a.role || "agent",
            swarm: a.swarm || "test-swarm",
            task: a.task || "Do some work",
            status: a.status || "running",
            ...a,
        };
        agentMap.set(info.name, info);
    }

    setSwarmState({
        generation: 1,
        group: null,
        groupPath: "/tmp/test-group",
        agents: agentMap,
        queenClients: new Map(),
    });
}

// Helper: create a readable stream that emits lines
function mockStdout(lines: string[]): NodeJS.ReadableStream {
    const stream = new Readable({ read() {} });
    process.nextTick(() => {
        stream.push(lines.join("\n") + "\n");
        stream.push(null);
    });
    return stream;
}

function waitForStream(stream: NodeJS.ReadableStream): Promise<void> {
    return new Promise((resolve) => {
        stream.on("close", () => setTimeout(resolve, 10));
    });
}

function toolStartEvent(toolName: string, args?: Record<string, unknown>) {
    return JSON.stringify({ type: "tool_execution_start", toolName, args });
}

function messageEndEvent(text: string, usage?: {
    input?: number; output?: number; cost?: { total: number };
}) {
    return JSON.stringify({
        type: "message_end",
        message: {
            role: "assistant",
            content: [{ type: "text", text }],
            usage,
        },
    });
}

// ─── Cleanup ────────────────────────────────────────────────────────

// We need to clean up swarm state between tests
function clearSwarmState(): void {
    // Set a null-like state then re-read
    // The actual cleanup is done by setting agents to empty
    const state = getSwarmState();
    if (state) {
        state.agents.clear();
    }
    clearActivity();
}

// ─── Tests ──────────────────────────────────────────────────────────

// Track overlays for cleanup (prevents hanging from uncleaned intervals)
let activeOverlays: DashboardOverlay[] = [];

function createOverlay(opts: ConstructorParameters<typeof DashboardOverlay>[0]): DashboardOverlay {
    const overlay = new DashboardOverlay(opts);
    activeOverlays.push(overlay);
    return overlay;
}

describe("DashboardOverlay", () => {
    beforeEach(() => {
        clearSwarmState();
    });

    afterEach(() => {
        // Dispose all overlays to stop their refresh timers
        for (const overlay of activeOverlays) {
            try { overlay.dispose(); } catch { /* ignore */ }
        }
        activeOverlays = [];
        clearSwarmState();
    });

    describe("render — empty state", () => {
        it("shows 'No active swarm' when no state exists", () => {
            // Don't set up any swarm state — just use cleared state
            // Force no agents by clearing the map
            const tui = mockTui();
            const theme = mockTheme();
            const done = mockDone();

            const overlay = createOverlay({ tui: tui as any, theme, done: done.fn });
            const lines = overlay.render(80);

            // Should mention no active swarm or agent dashboard
            const text = lines.join("\n");
            assert.ok(
                text.includes("No active swarm") || text.includes("Agent Dashboard"),
                `Expected empty state message, got: ${text}`
            );

        });
    });

    describe("render — list view", () => {
        it("renders agent list with status icons and names", () => {
            setupSwarm([
                { name: "a1", role: "agent", status: "running" },
                { name: "a2", role: "agent", status: "done", doneSummary: "finished tasks" },
            ]);

            const tui = mockTui();
            const theme = mockTheme();
            const done = mockDone();

            const overlay = createOverlay({ tui: tui as any, theme, done: done.fn });
            const lines = overlay.render(80);
            const text = lines.join("\n");

            // Should show dashboard header
            assert.ok(text.includes("Agent Dashboard"), "Should have dashboard header");

            // Should show both agents
            assert.ok(text.includes("a1"), "Should show agent a1");
            assert.ok(text.includes("a2"), "Should show agent a2");

            // Should show status icons
            assert.ok(text.includes("⏳"), "Running agent should have ⏳ icon");
            assert.ok(text.includes("✓"), "Done agent should have ✓ icon");

        });

        it("shows usage stats when available", async () => {
            setupSwarm([
                { name: "a1", role: "agent", status: "running" },
            ]);

            // Feed usage data through the activity store
            const stream = mockStdout([
                messageEndEvent("Turn 1", { input: 5000, output: 1000, cost: { total: 0.03 } }),
            ]);
            trackAgentOutput("a1", stream);
            await waitForStream(stream);

            const tui = mockTui();
            const theme = mockTheme();
            const done = mockDone();

            const overlay = createOverlay({ tui: tui as any, theme, done: done.fn });
            const lines = overlay.render(80);
            const text = lines.join("\n");

            // Should show usage: turns, tokens, cost
            assert.ok(text.includes("1t"), "Should show turn count");
            assert.ok(text.includes("$0.03"), "Should show cost");

        });

        it("shows current activity from last event", () => {
            setupSwarm([
                { name: "a1", role: "agent", status: "running" },
            ]);

            pushSyntheticEvent("a1", "tool_start", "read some/file.ts");

            const tui = mockTui();
            const theme = mockTheme();
            const done = mockDone();

            const overlay = createOverlay({ tui: tui as any, theme, done: done.fn });
            const lines = overlay.render(80);
            const text = lines.join("\n");

            assert.ok(text.includes("read some/file.ts"), "Should show last activity");

        });

        it("highlights selected row indicator", () => {
            setupSwarm([
                { name: "a1", role: "agent", status: "running" },
                { name: "a2", role: "agent", status: "running" },
            ]);

            const tui = mockTui();
            const theme = mockTheme();
            const done = mockDone();

            const overlay = createOverlay({ tui: tui as any, theme, done: done.fn });
            const lines = overlay.render(80);

            // First agent should be selected (▸ indicator)
            const a1Line = lines.find(l => l.includes("a1"));
            assert.ok(a1Line?.includes("▸"), "Selected row should have ▸ indicator");

            const a2Line = lines.find(l => l.includes("a2") && !l.includes("a1"));
            assert.ok(!a2Line?.includes("▸"), "Non-selected row should NOT have ▸ indicator");

        });

        it("shows aggregate stats in header", async () => {
            setupSwarm([
                { name: "a1", role: "agent", status: "done" },
                { name: "a2", role: "agent", status: "running" },
            ]);

            // Add some cost
            const stream = mockStdout([
                messageEndEvent("msg", { input: 1000, output: 200, cost: { total: 0.05 } }),
            ]);
            trackAgentOutput("a1", stream);
            await waitForStream(stream);

            const tui = mockTui();
            const theme = mockTheme();
            const done = mockDone();

            const overlay = createOverlay({ tui: tui as any, theme, done: done.fn });
            const lines = overlay.render(80);
            const text = lines.join("\n");

            assert.ok(text.includes("1/2 complete"), "Header should show completion count");
            assert.ok(text.includes("$0.05"), "Header should show aggregate cost");

        });

        it("shows footer with navigation hints", () => {
            setupSwarm([{ name: "a1", status: "running" }]);

            const tui = mockTui();
            const theme = mockTheme();
            const done = mockDone();

            const overlay = createOverlay({ tui: tui as any, theme, done: done.fn });
            const lines = overlay.render(80);
            const text = lines.join("\n");

            assert.ok(text.includes("navigate"), "Footer should mention navigation");
            assert.ok(text.includes("detail"), "Footer should mention detail");
            assert.ok(text.includes("close"), "Footer should mention close");

        });
    });

    describe("render — detail view", () => {
        it("shows agent detail when pre-focused", () => {
            setupSwarm([
                { name: "a1", role: "agent", status: "running", task: "Implement the dashboard" },
            ]);

            pushSyntheticEvent("a1", "tool_start", "read packages/file.ts");
            pushSyntheticEvent("a1", "message", "analyzing code");

            const tui = mockTui();
            const theme = mockTheme();
            const done = mockDone();

            const overlay = createOverlay({
                tui: tui as any, theme, done: done.fn,
                focusAgent: "a1",
            });
            const lines = overlay.render(80);
            const text = lines.join("\n");

            // Should show agent name and status
            assert.ok(text.includes("a1"), "Should show agent name");

            // Should show task
            assert.ok(text.includes("Task:"), "Should show task heading");
            assert.ok(text.includes("Implement the dashboard"), "Should show task text");

            // Should show activity
            assert.ok(text.includes("Activity:"), "Should show activity heading");
            assert.ok(text.includes("read packages/file.ts"), "Should show tool event");
            assert.ok(text.includes("analyzing code"), "Should show message event");

            // Should show back hint
            assert.ok(text.includes("back"), "Should show back navigation hint");

        });

        it("shows done summary in detail view", () => {
            setupSwarm([
                { name: "a1", status: "done", doneSummary: "Completed all research tasks" },
            ]);

            const tui = mockTui();
            const theme = mockTheme();
            const done = mockDone();

            const overlay = createOverlay({
                tui: tui as any, theme, done: done.fn,
                focusAgent: "a1",
            });
            const lines = overlay.render(80);
            const text = lines.join("\n");

            assert.ok(text.includes("Completed all research tasks"), "Should show done summary");

        });

        it("shows blocker in detail view", () => {
            setupSwarm([
                { name: "a1", status: "blocked", blockerDescription: "Waiting for API access" },
            ]);

            const tui = mockTui();
            const theme = mockTheme();
            const done = mockDone();

            const overlay = createOverlay({
                tui: tui as any, theme, done: done.fn,
                focusAgent: "a1",
            });
            const lines = overlay.render(80);
            const text = lines.join("\n");

            assert.ok(text.includes("Waiting for API access"), "Should show blocker");

        });

        it("shows usage stats at bottom of detail view", async () => {
            setupSwarm([
                { name: "a1", status: "running" },
            ]);

            const stream = mockStdout([
                messageEndEvent("Turn 1", { input: 2000, output: 500, cost: { total: 0.01 } }),
                messageEndEvent("Turn 2", { input: 3000, output: 800, cost: { total: 0.02 } }),
            ]);
            trackAgentOutput("a1", stream);
            await waitForStream(stream);

            const tui = mockTui();
            const theme = mockTheme();
            const done = mockDone();

            const overlay = createOverlay({
                tui: tui as any, theme, done: done.fn,
                focusAgent: "a1",
            });
            const lines = overlay.render(80);
            const text = lines.join("\n");

            // Should show accumulated usage
            assert.ok(text.includes("2 turns"), "Should show turn count");

        });
    });

    describe("keyboard handling — list view", () => {
        it("moves selection down with ↓", () => {
            setupSwarm([
                { name: "a1", status: "running" },
                { name: "a2", status: "running" },
                { name: "a3", status: "running" },
            ]);

            const tui = mockTui();
            const theme = mockTheme();
            const done = mockDone();

            const overlay = createOverlay({ tui: tui as any, theme, done: done.fn });

            // Initially a1 is selected (index 0)
            let lines = overlay.render(80);
            let a1Line = lines.find(l => l.includes("a1"));
            assert.ok(a1Line?.includes("▸"), "a1 should be initially selected");

            // Press down
            overlay.handleInput("\x1b[B");
            lines = overlay.render(80);
            const a2Line = lines.find(l => l.includes("a2") && !l.includes("a1"));
            assert.ok(a2Line?.includes("▸"), "a2 should be selected after ↓");

        });

        it("moves selection up with ↑", () => {
            setupSwarm([
                { name: "a1", status: "running" },
                { name: "a2", status: "running" },
            ]);

            const tui = mockTui();
            const theme = mockTheme();
            const done = mockDone();

            const overlay = createOverlay({ tui: tui as any, theme, done: done.fn });

            // Move down then back up
            overlay.handleInput("\x1b[B"); // down to a2
            overlay.handleInput("\x1b[A"); // up to a1

            const lines = overlay.render(80);
            const a1Line = lines.find(l => l.includes("a1"));
            assert.ok(a1Line?.includes("▸"), "a1 should be selected after ↑");

        });

        it("does not go below last agent", () => {
            setupSwarm([
                { name: "a1", status: "running" },
                { name: "a2", status: "running" },
            ]);

            const tui = mockTui();
            const theme = mockTheme();
            const done = mockDone();

            const overlay = createOverlay({ tui: tui as any, theme, done: done.fn });

            // Press down many times
            overlay.handleInput("\x1b[B");
            overlay.handleInput("\x1b[B");
            overlay.handleInput("\x1b[B");

            const lines = overlay.render(80);
            const a2Line = lines.find(l => l.includes("a2") && !l.includes("a1"));
            assert.ok(a2Line?.includes("▸"), "Should stay on last agent");

        });

        it("does not go above first agent", () => {
            setupSwarm([
                { name: "a1", status: "running" },
                { name: "a2", status: "running" },
            ]);

            const tui = mockTui();
            const theme = mockTheme();
            const done = mockDone();

            const overlay = createOverlay({ tui: tui as any, theme, done: done.fn });

            // Press up (already at 0)
            overlay.handleInput("\x1b[A");

            const lines = overlay.render(80);
            const a1Line = lines.find(l => l.includes("a1"));
            assert.ok(a1Line?.includes("▸"), "Should stay on first agent");

        });

        it("Enter drills into detail view", () => {
            setupSwarm([
                { name: "a1", status: "running", task: "Some task" },
            ]);

            const tui = mockTui();
            const theme = mockTheme();
            const done = mockDone();

            const overlay = createOverlay({ tui: tui as any, theme, done: done.fn });

            // Press Enter
            overlay.handleInput("\r");

            const lines = overlay.render(80);
            const text = lines.join("\n");

            // Should now be in detail view
            assert.ok(text.includes("Task:"), "Should show detail view after Enter");
            assert.ok(text.includes("Some task"), "Should show agent task");

        });

        it("Escape closes the overlay", () => {
            setupSwarm([{ name: "a1", status: "running" }]);

            const tui = mockTui();
            const theme = mockTheme();
            const done = mockDone();

            const overlay = createOverlay({ tui: tui as any, theme, done: done.fn });
            overlay.handleInput("\x1b");

            assert.ok(done.called, "Escape should call done()");
        });

        it("q closes the overlay", () => {
            setupSwarm([{ name: "a1", status: "running" }]);

            const tui = mockTui();
            const theme = mockTheme();
            const done = mockDone();

            const overlay = createOverlay({ tui: tui as any, theme, done: done.fn });
            overlay.handleInput("q");

            assert.ok(done.called, "q should call done()");
        });
    });

    describe("keyboard handling — detail view", () => {
        it("Escape goes back to list view", () => {
            setupSwarm([
                { name: "a1", status: "running", task: "Task A" },
                { name: "a2", status: "running", task: "Task B" },
            ]);

            const tui = mockTui();
            const theme = mockTheme();
            const done = mockDone();

            const overlay = createOverlay({
                tui: tui as any, theme, done: done.fn,
                focusAgent: "a1",
            });

            // Should be in detail view
            let lines = overlay.render(80);
            assert.ok(lines.join("\n").includes("Task:"), "Should start in detail view");

            // Press Escape — should go back to list
            overlay.handleInput("\x1b");
            lines = overlay.render(80);
            const text = lines.join("\n");

            assert.ok(!text.includes("Task:"), "Should be back in list view");
            assert.ok(text.includes("a1") && text.includes("a2"), "Should show both agents in list");
            assert.ok(!done.called, "Escape in detail should NOT close overlay");

        });

        it("q closes overlay from detail view", () => {
            setupSwarm([{ name: "a1", status: "running" }]);

            const tui = mockTui();
            const theme = mockTheme();
            const done = mockDone();

            const overlay = createOverlay({
                tui: tui as any, theme, done: done.fn,
                focusAgent: "a1",
            });

            overlay.handleInput("q");
            assert.ok(done.called, "q should close overlay from detail view");
        });

        it("↓ increments scroll offset in detail view", () => {
            setupSwarm([{ name: "a1", status: "running" }]);

            // Add many events to make it scrollable
            for (let i = 0; i < 20; i++) {
                pushSyntheticEvent("a1", "tool_start", `read file${i}.ts`);
            }

            const tui = mockTui();
            const theme = mockTheme();
            const done = mockDone();

            const overlay = createOverlay({
                tui: tui as any, theme, done: done.fn,
                focusAgent: "a1",
            });

            // Initial render to populate lastMaxScroll
            overlay.render(80);

            // Scroll down a few times
            overlay.handleInput("\x1b[B");
            overlay.handleInput("\x1b[B");
            overlay.handleInput("\x1b[B");

            const lines = overlay.render(80);
            const text = lines.join("\n");

            // Should show scroll indicator
            assert.ok(text.includes("above"), "Should show scroll-up indicator");

        });
    });

    describe("live refresh", () => {
        it("new events appear on re-render", () => {
            setupSwarm([{ name: "a1", status: "running" }]);

            const tui = mockTui();
            const theme = mockTheme();
            const done = mockDone();

            const overlay = createOverlay({
                tui: tui as any, theme, done: done.fn,
                focusAgent: "a1",
            });

            // Initial render
            let lines = overlay.render(80);
            let text = lines.join("\n");
            assert.ok(!text.includes("file.ts"), "Should not show file.ts yet");

            // Add new event
            pushSyntheticEvent("a1", "tool_start", "read file.ts");

            // Re-render (simulating timer callback)
            lines = overlay.render(80);
            text = lines.join("\n");
            assert.ok(text.includes("file.ts"), "Should show new event after re-render");

        });

        it("usage stats update on re-render", async () => {
            setupSwarm([{ name: "a1", status: "running" }]);

            const tui = mockTui();
            const theme = mockTheme();
            const done = mockDone();

            const overlay = createOverlay({ tui: tui as any, theme, done: done.fn });

            // Initial render — no usage
            let lines = overlay.render(80);
            let text = lines.join("\n");
            assert.ok(!text.includes("$0.04"), "Should not show cost yet");

            // Feed usage data
            const stream = mockStdout([
                messageEndEvent("msg", { input: 2000, output: 500, cost: { total: 0.04 } }),
            ]);
            trackAgentOutput("a1", stream);
            await waitForStream(stream);

            // Re-render
            lines = overlay.render(80);
            text = lines.join("\n");
            assert.ok(text.includes("$0.04"), "Should show updated cost after re-render");

        });

        it("dispose stops the refresh timer", () => {
            setupSwarm([{ name: "a1", status: "running" }]);

            const tui = mockTui();
            const theme = mockTheme();
            const done = mockDone();

            const overlay = createOverlay({ tui: tui as any, theme, done: done.fn });

            // Dispose should not throw
            assert.doesNotThrow(() => overlay.dispose!());

            // Double dispose should also not throw
            assert.doesNotThrow(() => overlay.dispose!());
        });
    });

    describe("agent sorting", () => {
        it("sorts running agents before done agents", () => {
            setupSwarm([
                { name: "a-done", status: "done" },
                { name: "b-running", status: "running" },
                { name: "c-blocked", status: "blocked" },
            ]);

            const tui = mockTui();
            const theme = mockTheme();
            const done = mockDone();

            const overlay = createOverlay({ tui: tui as any, theme, done: done.fn });
            const lines = overlay.render(80);

            // Find the agent lines (containing agent names)
            const agentLines = lines.filter(l =>
                l.includes("b-running") || l.includes("c-blocked") || l.includes("a-done")
            );

            // Running should come first, then blocked, then done
            const runningIdx = agentLines.findIndex(l => l.includes("b-running"));
            const blockedIdx = agentLines.findIndex(l => l.includes("c-blocked"));
            const doneIdx = agentLines.findIndex(l => l.includes("a-done"));

            assert.ok(runningIdx < blockedIdx, "Running should come before blocked");
            assert.ok(blockedIdx < doneIdx, "Blocked should come before done");

        });
    });

    describe("focusAgent option", () => {
        it("opens directly to detail view when focusAgent matches", () => {
            setupSwarm([
                { name: "a1", status: "running", task: "Build the overlay" },
                { name: "a2", status: "running" },
            ]);

            const tui = mockTui();
            const theme = mockTheme();
            const done = mockDone();

            const overlay = createOverlay({
                tui: tui as any, theme, done: done.fn,
                focusAgent: "a2",
            });
            const lines = overlay.render(80);
            const text = lines.join("\n");

            // Should be in detail view for a2
            assert.ok(text.includes("a2"), "Should show a2 in detail");
            assert.ok(text.includes("Task:"), "Should show task heading (detail view)");

        });

        it("falls back to list view when focusAgent not found", () => {
            setupSwarm([
                { name: "a1", status: "running" },
            ]);

            const tui = mockTui();
            const theme = mockTheme();
            const done = mockDone();

            const overlay = createOverlay({
                tui: tui as any, theme, done: done.fn,
                focusAgent: "nonexistent",
            });
            const lines = overlay.render(80);
            const text = lines.join("\n");

            // Should be in list view (no Task: heading)
            assert.ok(!text.includes("Task:"), "Should fall back to list view");
            assert.ok(text.includes("a1"), "Should show agents in list");

        });
    });

    describe("openDashboardOverlay", () => {
        it("is a no-op when ctx.hasUI is false", () => {
            const { openDashboardOverlay } = require("../../ui/overlay.js");
            let customCalled = false;
            const ctx = {
                hasUI: false,
                ui: {
                    custom: () => { customCalled = true; },
                },
            };
            openDashboardOverlay(ctx);
            assert.equal(customCalled, false);
        });

        it("calls ctx.ui.custom when ctx.hasUI is true", () => {
            const { openDashboardOverlay } = require("../../ui/overlay.js");
            let customCalled = false;
            const ctx = {
                hasUI: true,
                ui: {
                    custom: () => { customCalled = true; },
                },
            };
            openDashboardOverlay(ctx);
            assert.equal(customCalled, true);
        });
    });
});
