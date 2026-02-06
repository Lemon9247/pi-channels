/**
 * Synthetic activity tests
 */

import { test, assertEqual, summarize } from "../helpers.js";
import { pushSyntheticEvent, getAgentActivity, clearActivity } from "../../ui/activity.js";

async function main() {
    console.log("\nSynthetic Activity:");

    await test("pushSyntheticEvent stores events retrievable via getAgentActivity", async () => {
        clearActivity();
        pushSyntheticEvent("test-agent", "message", "registered (agent, s1)");
        pushSyntheticEvent("test-agent", "tool_end", "✓ done: completed");

        const events = getAgentActivity("test-agent");
        assertEqual(events.length, 2, "2 events");
        assertEqual(events[0].summary, "registered (agent, s1)", "first event");
        assertEqual(events[1].summary, "✓ done: completed", "second event");
        clearActivity();
    });

    await test("pushSyntheticEvent — different agents have separate feeds", async () => {
        clearActivity();
        pushSyntheticEvent("alpha", "message", "event-a");
        pushSyntheticEvent("beta", "message", "event-b");

        assertEqual(getAgentActivity("alpha").length, 1, "alpha has 1");
        assertEqual(getAgentActivity("beta").length, 1, "beta has 1");
        assertEqual(getAgentActivity("alpha")[0].summary, "event-a", "alpha event");
        assertEqual(getAgentActivity("beta")[0].summary, "event-b", "beta event");
        clearActivity();
    });
}

main().then(() => summarize());
