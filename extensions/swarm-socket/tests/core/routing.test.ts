/**
 * Router tests: canReach rules, getRecipients
 */

import { test, assert, assertEqual, summarize } from "../helpers.js";
import { DefaultRouter, type SenderInfo } from "../../core/router.js";

async function main() {
    console.log("\nRouter:");

    const router = new DefaultRouter();

    await test("queen can reach anyone", async () => {
        const queen: SenderInfo = { name: "queen", role: "queen" };
        assert(router.canReach(queen, { name: "a1", role: "agent", swarm: "s1" }), "queen → agent");
        assert(router.canReach(queen, { name: "coord", role: "coordinator", swarm: "s1" }), "queen → coordinator");
        assert(router.canReach(queen, { name: "q2", role: "queen" }), "queen → queen");
    });

    await test("agent can reach same-swarm siblings and coordinator", async () => {
        const a1: SenderInfo = { name: "a1", role: "agent", swarm: "s1" };
        assert(router.canReach(a1, { name: "a2", role: "agent", swarm: "s1" }), "agent → same swarm agent");
        assert(router.canReach(a1, { name: "coord", role: "coordinator", swarm: "s1" }), "agent → same swarm coordinator");
        assert(!router.canReach(a1, { name: "b1", role: "agent", swarm: "s2" }), "agent ✗ other swarm agent");
        assert(!router.canReach(a1, { name: "queen", role: "queen" }), "agent ✗ queen");
        assert(!router.canReach(a1, { name: "coord-b", role: "coordinator", swarm: "s2" }), "agent ✗ other swarm coordinator");
    });

    await test("coordinator can reach own agents, other coordinators, and queen", async () => {
        const coord: SenderInfo = { name: "coord-a", role: "coordinator", swarm: "s1" };
        assert(router.canReach(coord, { name: "a1", role: "agent", swarm: "s1" }), "coordinator → own agent");
        assert(router.canReach(coord, { name: "coord-b", role: "coordinator", swarm: "s2" }), "coordinator → other coordinator");
        assert(router.canReach(coord, { name: "queen", role: "queen" }), "coordinator → queen");
        assert(!router.canReach(coord, { name: "b1", role: "agent", swarm: "s2" }), "coordinator ✗ other swarm agent");
    });

    await test("getRecipients filters by canReach for broadcast", async () => {
        const clients = new Map<string, SenderInfo>();
        clients.set("a1", { name: "a1", role: "agent", swarm: "s1" });
        clients.set("a2", { name: "a2", role: "agent", swarm: "s1" });
        clients.set("b1", { name: "b1", role: "agent", swarm: "s2" });
        clients.set("coord", { name: "coord", role: "coordinator", swarm: "s1" });

        const from: SenderInfo = { name: "a1", role: "agent", swarm: "s1" };
        const recipients = router.getRecipients(from, { type: "nudge", reason: "test" }, clients);
        const names = recipients.map(r => r.name).sort();
        assertEqual(names.length, 2, "a1 reaches a2 and coord");
        assertEqual(names[0], "a2", "reaches a2");
        assertEqual(names[1], "coord", "reaches coord");
    });

    await test("getRecipients handles instruct targeting", async () => {
        const clients = new Map<string, SenderInfo>();
        clients.set("a1", { name: "a1", role: "agent", swarm: "s1" });
        clients.set("a2", { name: "a2", role: "agent", swarm: "s1" });
        clients.set("b1", { name: "b1", role: "agent", swarm: "s2" });

        const queen: SenderInfo = { name: "queen", role: "queen" };

        // Target specific agent
        const r1 = router.getRecipients(queen, { type: "instruct", instruction: "x", to: "a1" }, clients);
        assertEqual(r1.length, 1, "targeted instruct hits 1");
        assertEqual(r1[0].name, "a1", "hits a1");

        // Target swarm
        const r2 = router.getRecipients(queen, { type: "instruct", instruction: "x", swarm: "s1" }, clients);
        assertEqual(r2.length, 2, "swarm instruct hits 2");

        // Broadcast
        const r3 = router.getRecipients(queen, { type: "instruct", instruction: "x" }, clients);
        assertEqual(r3.length, 3, "broadcast instruct hits all");
    });
}

main().then(() => summarize());
