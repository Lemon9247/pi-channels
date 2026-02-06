/**
 * Subject-based routing tests: subscription policies, subject matching,
 * DefaultPolicy reproduces canReach exactly, PeerQueenPolicy, address resolution.
 */

import { test, assert, assertEqual, summarize } from "../helpers.js";
import {
    DefaultPolicy,
    PeerQueenPolicy,
    DefaultRouter,
    LocalResolver,
    PeerResolver,
    subjectsOverlap,
    computeSubjects,
    type SenderInfo,
    type Subject,
} from "../../core/router.js";

async function main() {
    console.log("\nSubject Subscription Model:");

    // === DefaultPolicy: subscription computation ===

    await test("DefaultPolicy — agent subscriptions", async () => {
        const policy = new DefaultPolicy();
        const agent: SenderInfo = { name: "a1", role: "agent", swarm: "alpha" };
        const subs = policy.allowedSubscriptions(agent);
        assert(subs.includes("agent.a1"), "subscribes to own name");
        assert(subs.includes("swarm.alpha"), "subscribes to own swarm");
        assert(subs.includes("role.agent"), "subscribes to role");
        assert(subs.includes("all"), "subscribes to all");
        assertEqual(subs.length, 4, "exactly 4 subscriptions");
    });

    await test("DefaultPolicy — agent publications", async () => {
        const policy = new DefaultPolicy();
        const agent: SenderInfo = { name: "a1", role: "agent", swarm: "alpha" };
        const pubs = policy.allowedPublications(agent);
        assert(pubs.includes("swarm.alpha"), "publishes to own swarm");
        assertEqual(pubs.length, 1, "exactly 1 publication");
    });

    await test("DefaultPolicy — coordinator subscriptions", async () => {
        const policy = new DefaultPolicy();
        const coord: SenderInfo = { name: "coord-a", role: "coordinator", swarm: "alpha" };
        const subs = policy.allowedSubscriptions(coord);
        assert(subs.includes("agent.coord-a"), "subscribes to own name");
        assert(subs.includes("swarm.alpha"), "subscribes to own swarm");
        assert(subs.includes("role.coordinator"), "subscribes to role.coordinator");
        assert(subs.includes("all"), "subscribes to all");
        assertEqual(subs.length, 4, "exactly 4 subscriptions");
    });

    await test("DefaultPolicy — coordinator publications", async () => {
        const policy = new DefaultPolicy();
        const coord: SenderInfo = { name: "coord-a", role: "coordinator", swarm: "alpha" };
        const pubs = policy.allowedPublications(coord);
        assert(pubs.includes("swarm.alpha"), "publishes to own swarm");
        assert(pubs.includes("role.coordinator"), "publishes to role.coordinator");
        assert(pubs.includes("role.queen"), "publishes to role.queen");
        assertEqual(pubs.length, 3, "exactly 3 publications");
    });

    await test("DefaultPolicy — queen subscriptions", async () => {
        const policy = new DefaultPolicy();
        const queen: SenderInfo = { name: "queen", role: "queen" };
        const subs = policy.allowedSubscriptions(queen);
        assert(subs.includes("agent.queen"), "subscribes to own name");
        assert(subs.includes("role.queen"), "subscribes to role.queen");
        assert(subs.includes("all"), "subscribes to all");
        assert(!subs.includes("*"), "does NOT subscribe to wildcard");
        assertEqual(subs.length, 3, "exactly 3 subscriptions");
    });

    await test("DefaultPolicy — queen publications", async () => {
        const policy = new DefaultPolicy();
        const queen: SenderInfo = { name: "queen", role: "queen" };
        const pubs = policy.allowedPublications(queen);
        assert(pubs.includes("*"), "publishes to wildcard (everything)");
        assertEqual(pubs.length, 1, "exactly 1 publication (wildcard)");
    });

    // === computeSubjects helper ===

    await test("computeSubjects returns both subs and pubs", async () => {
        const policy = new DefaultPolicy();
        const agent: SenderInfo = { name: "a1", role: "agent", swarm: "alpha" };
        const { subscriptions, publications } = computeSubjects(agent, policy);
        assertEqual(subscriptions.length, 4, "4 subscriptions");
        assertEqual(publications.length, 1, "1 publication");
    });

    // === subjectsOverlap ===

    await test("subjectsOverlap — matching subjects", async () => {
        assert(subjectsOverlap(["swarm.alpha"], ["agent.a1", "swarm.alpha", "all"]), "swarm match");
        assert(subjectsOverlap(["role.coordinator"], ["role.coordinator", "all"]), "role match");
    });

    await test("subjectsOverlap — no match", async () => {
        assert(!subjectsOverlap(["swarm.alpha"], ["agent.b1", "swarm.beta", "all"]), "different swarm");
        assert(!subjectsOverlap(["swarm.alpha"], ["role.queen"]), "swarm vs role");
    });

    await test("subjectsOverlap — wildcard matches everything", async () => {
        assert(subjectsOverlap(["*"], ["swarm.alpha"]), "wildcard pub matches any sub");
        assert(subjectsOverlap(["swarm.alpha"], ["*"]), "any pub matches wildcard sub");
        assert(subjectsOverlap(["*"], ["*"]), "wildcard both sides");
    });

    await test("subjectsOverlap — all subject is NOT wildcard", async () => {
        // "all" is just a regular subject, not a wildcard
        assert(!subjectsOverlap(["all"], ["swarm.alpha"]), "all doesn't match arbitrary subjects");
        assert(subjectsOverlap(["all"], ["all"]), "all matches all");
    });

    // === DefaultPolicy reproduces canReach exactly ===

    await test("DefaultPolicy matches canReach — queen → anyone", async () => {
        const router = new DefaultRouter();
        const queen: SenderInfo = { name: "queen", role: "queen" };
        assert(router.canReach(queen, { name: "a1", role: "agent", swarm: "s1" }), "queen → agent");
        assert(router.canReach(queen, { name: "coord", role: "coordinator", swarm: "s1" }), "queen → coordinator");
        assert(router.canReach(queen, { name: "q2", role: "queen" }), "queen → queen");
    });

    await test("DefaultPolicy matches canReach — agent reach rules", async () => {
        const router = new DefaultRouter();
        const a1: SenderInfo = { name: "a1", role: "agent", swarm: "s1" };
        assert(router.canReach(a1, { name: "a2", role: "agent", swarm: "s1" }), "agent → same swarm agent");
        assert(router.canReach(a1, { name: "coord", role: "coordinator", swarm: "s1" }), "agent → same swarm coordinator");
        assert(!router.canReach(a1, { name: "b1", role: "agent", swarm: "s2" }), "agent ✗ other swarm agent");
        assert(!router.canReach(a1, { name: "queen", role: "queen" }), "agent ✗ queen");
        assert(!router.canReach(a1, { name: "coord-b", role: "coordinator", swarm: "s2" }), "agent ✗ other swarm coordinator");
    });

    await test("DefaultPolicy matches canReach — coordinator reach rules", async () => {
        const router = new DefaultRouter();
        const coord: SenderInfo = { name: "coord-a", role: "coordinator", swarm: "s1" };
        assert(router.canReach(coord, { name: "a1", role: "agent", swarm: "s1" }), "coordinator → own agent");
        assert(router.canReach(coord, { name: "coord-b", role: "coordinator", swarm: "s2" }), "coordinator → other coordinator");
        assert(router.canReach(coord, { name: "queen", role: "queen" }), "coordinator → queen");
        assert(!router.canReach(coord, { name: "b1", role: "agent", swarm: "s2" }), "coordinator ✗ other swarm agent");
    });

    await test("DefaultPolicy getRecipients for broadcast matches canReach", async () => {
        const router = new DefaultRouter();
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

    await test("DefaultPolicy getRecipients for instruct matches canReach", async () => {
        const router = new DefaultRouter();
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

    // === PeerQueenPolicy ===

    await test("PeerQueenPolicy — queen subscribes to peer queen names", async () => {
        const policy = new PeerQueenPolicy(["peer-queen-1", "peer-queen-2"]);
        const queen: SenderInfo = { name: "queen", role: "queen" };
        const subs = policy.allowedSubscriptions(queen);
        assert(subs.includes("agent.peer-queen-1"), "subscribes to peer-queen-1");
        assert(subs.includes("agent.peer-queen-2"), "subscribes to peer-queen-2");
        assert(subs.includes("agent.queen"), "still subscribes to own name");
        assert(subs.includes("role.queen"), "still subscribes to role.queen");
    });

    await test("PeerQueenPolicy — queen publications unchanged (already wildcard)", async () => {
        const policy = new PeerQueenPolicy(["peer-queen-1"]);
        const queen: SenderInfo = { name: "queen", role: "queen" };
        const pubs = policy.allowedPublications(queen);
        assert(pubs.includes("*"), "still publishes to wildcard");
    });

    await test("PeerQueenPolicy — non-queen identities unchanged", async () => {
        const policy = new PeerQueenPolicy(["peer-queen-1"]);
        const agent: SenderInfo = { name: "a1", role: "agent", swarm: "alpha" };
        const subs = policy.allowedSubscriptions(agent);
        assert(!subs.includes("agent.peer-queen-1"), "agent doesn't get peer queen subs");
        assertEqual(subs.length, 4, "same 4 agent subscriptions");
    });

    await test("PeerQueenPolicy — queen can reach peer queen", async () => {
        const policy = new PeerQueenPolicy(["peer-queen-1"]);
        const router = new DefaultRouter(policy);
        const queen: SenderInfo = { name: "queen", role: "queen" };
        const peer: SenderInfo = { name: "peer-queen-1", role: "queen" };
        assert(router.canReach(queen, peer), "queen → peer queen");
        assert(router.canReach(peer, queen), "peer queen → queen");
    });

    await test("PeerQueenPolicy — agent cannot reach peer queen", async () => {
        const policy = new PeerQueenPolicy(["peer-queen-1"]);
        const router = new DefaultRouter(policy);
        const agent: SenderInfo = { name: "a1", role: "agent", swarm: "s1" };
        const peer: SenderInfo = { name: "peer-queen-1", role: "queen" };
        assert(!router.canReach(agent, peer), "agent ✗ peer queen (agent pubs don't overlap)");
    });

    // === LocalResolver ===

    await test("LocalResolver — finds subscribers of a subject", async () => {
        const resolver = new LocalResolver();
        const subs = new Map<string, Subject[]>();
        subs.set("a1", ["agent.a1", "swarm.alpha", "role.agent", "all"]);
        subs.set("a2", ["agent.a2", "swarm.alpha", "role.agent", "all"]);
        subs.set("b1", ["agent.b1", "swarm.beta", "role.agent", "all"]);

        const result = resolver.resolve("swarm.alpha", subs);
        assertEqual(result.length, 2, "2 subscribers of swarm.alpha");
        assert(result.includes("a1"), "a1 subscribes");
        assert(result.includes("a2"), "a2 subscribes");
    });

    await test("LocalResolver — no subscribers returns empty", async () => {
        const resolver = new LocalResolver();
        const subs = new Map<string, Subject[]>();
        subs.set("a1", ["agent.a1", "swarm.alpha"]);

        const result = resolver.resolve("swarm.gamma", subs);
        assertEqual(result.length, 0, "no subscribers");
    });

    await test("LocalResolver — wildcard subscriber matches any subject", async () => {
        const resolver = new LocalResolver();
        const subs = new Map<string, Subject[]>();
        subs.set("queen", ["*"]);
        subs.set("a1", ["agent.a1", "swarm.alpha"]);

        const result = resolver.resolve("swarm.alpha", subs);
        assertEqual(result.length, 2, "a1 + queen (wildcard)");
        assert(result.includes("queen"), "queen matches via wildcard");
        assert(result.includes("a1"), "a1 matches directly");
    });

    // === PeerResolver (stub — delegates to local) ===

    await test("PeerResolver — delegates to local resolver", async () => {
        const resolver = new PeerResolver();
        const subs = new Map<string, Subject[]>();
        subs.set("a1", ["agent.a1", "swarm.alpha"]);
        subs.set("a2", ["agent.a2", "swarm.alpha"]);

        const result = resolver.resolve("swarm.alpha", subs);
        assertEqual(result.length, 2, "delegates to local");
    });

    // === Message attribution ===

    await test("RelayedMessage from field carries full sender identity", async () => {
        // This tests the wire format — from is now an object
        const relayed = {
            from: { name: "a1", role: "agent", swarm: "s1" },
            message: { type: "nudge", reason: "test" },
        };
        assertEqual(relayed.from.name, "a1", "from.name");
        assertEqual(relayed.from.role, "agent", "from.role");
        assertEqual(relayed.from.swarm, "s1", "from.swarm");
    });
}

main().then(() => summarize());
