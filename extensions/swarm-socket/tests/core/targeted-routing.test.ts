/**
 * Targeted routing tests: verify router handles to/swarm on all message types
 */

import { test, assert, assertEqual, summarize } from "../helpers.js";
import { DefaultRouter, type SenderInfo } from "../../core/router.js";
import type { NudgeMessage, BlockerMessage, DoneMessage, ProgressMessage, RelayMessage } from "../../transport/protocol.js";

async function main() {
    console.log("\nTargeted Routing:");

    const router = new DefaultRouter();

    const clients = new Map<string, SenderInfo>();
    clients.set("a1", { name: "a1", role: "agent", swarm: "s1" });
    clients.set("a2", { name: "a2", role: "agent", swarm: "s1" });
    clients.set("a3", { name: "a3", role: "agent", swarm: "s1" });
    clients.set("coord", { name: "coord", role: "coordinator", swarm: "s1" });
    clients.set("b1", { name: "b1", role: "agent", swarm: "s2" });

    await test("targeted nudge (to) routes to single recipient", async () => {
        const from: SenderInfo = { name: "a1", role: "agent", swarm: "s1" };
        const msg: NudgeMessage = { type: "nudge", reason: "test", to: "a2" };
        const recipients = router.getRecipients(from, msg, clients);
        assertEqual(recipients.length, 1, "one recipient");
        assertEqual(recipients[0].name, "a2", "correct target");
    });

    await test("targeted nudge (swarm) routes to all in swarm", async () => {
        const from: SenderInfo = { name: "queen", role: "queen" };
        const msg: NudgeMessage = { type: "nudge", reason: "test", swarm: "s1" };
        // queen is not in the clients map, so add temporarily
        const withQueen = new Map(clients);
        withQueen.set("queen", { name: "queen", role: "queen" });
        const recipients = router.getRecipients(from, msg, withQueen);
        const names = recipients.map(r => r.name).sort();
        assertEqual(names.length, 4, "4 recipients in s1"); // a1, a2, a3, coord
        assert(names.includes("a1"), "includes a1");
        assert(names.includes("coord"), "includes coord");
        assert(!names.includes("b1"), "excludes b1");
    });

    await test("untargeted nudge broadcasts to all reachable", async () => {
        const from: SenderInfo = { name: "a1", role: "agent", swarm: "s1" };
        const msg: NudgeMessage = { type: "nudge", reason: "test" };
        const recipients = router.getRecipients(from, msg, clients);
        // a1 can reach a2, a3, coord (same swarm)
        assertEqual(recipients.length, 3, "3 recipients");
    });

    await test("targeted blocker routes to single recipient", async () => {
        const from: SenderInfo = { name: "a1", role: "agent", swarm: "s1" };
        const msg: BlockerMessage = { type: "blocker", description: "stuck", to: "coord" };
        const recipients = router.getRecipients(from, msg, clients);
        assertEqual(recipients.length, 1, "one recipient");
        assertEqual(recipients[0].name, "coord", "targets coordinator");
    });

    await test("targeted done message routes to single recipient", async () => {
        const from: SenderInfo = { name: "a1", role: "agent", swarm: "s1" };
        const msg: DoneMessage = { type: "done", summary: "finished", to: "coord" };
        const recipients = router.getRecipients(from, msg, clients);
        assertEqual(recipients.length, 1, "one recipient");
        assertEqual(recipients[0].name, "coord", "targets coordinator");
    });

    await test("targeted progress routes to single recipient", async () => {
        const from: SenderInfo = { name: "a1", role: "agent", swarm: "s1" };
        const msg: ProgressMessage = { type: "progress", phase: "testing", to: "coord" };
        const recipients = router.getRecipients(from, msg, clients);
        assertEqual(recipients.length, 1, "one recipient");
        assertEqual(recipients[0].name, "coord", "targets coordinator");
    });

    await test("targeted relay routes to coordinator", async () => {
        const from: SenderInfo = { name: "coord", role: "coordinator", swarm: "s1" };
        const withQueen = new Map(clients);
        withQueen.set("queen", { name: "queen", role: "queen" });
        const msg: RelayMessage = {
            type: "relay",
            relay: { event: "done", name: "x", role: "agent", swarm: "s1", code: "0.1" },
            to: "queen",
        };
        const recipients = router.getRecipients(from, msg, withQueen);
        assertEqual(recipients.length, 1, "one recipient");
        assertEqual(recipients[0].name, "queen", "targets queen");
    });

    await test("targeting respects canReach — agent cannot target queen directly", async () => {
        const from: SenderInfo = { name: "a1", role: "agent", swarm: "s1" };
        const withQueen = new Map(clients);
        withQueen.set("queen", { name: "queen", role: "queen" });
        const msg: NudgeMessage = { type: "nudge", reason: "test", to: "queen" };
        const recipients = router.getRecipients(from, msg, withQueen);
        assertEqual(recipients.length, 0, "agent can't reach queen");
    });

    await test("targeting respects canReach — agent cannot target other-swarm agent", async () => {
        const from: SenderInfo = { name: "a1", role: "agent", swarm: "s1" };
        const msg: NudgeMessage = { type: "nudge", reason: "test", to: "b1" };
        const recipients = router.getRecipients(from, msg, clients);
        assertEqual(recipients.length, 0, "a1 can't reach b1");
    });

    await test("no recipients for targeted message returns empty array", async () => {
        const from: SenderInfo = { name: "a1", role: "agent", swarm: "s1" };
        const msg: NudgeMessage = { type: "nudge", reason: "test", to: "nonexistent" };
        const recipients = router.getRecipients(from, msg, clients);
        assertEqual(recipients.length, 0, "no recipients");
    });
}

main().then(() => summarize());
