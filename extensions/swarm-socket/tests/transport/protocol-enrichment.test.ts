/**
 * Protocol enrichment tests: new message types, targeting, payload, validation
 */

import { test, assert, assertEqual, summarize } from "../helpers.js";
import {
    serialize,
    validateClientMessage,
    getMessageTarget,
    type NudgeMessage,
    type BlockerMessage,
    type DoneMessage,
    type InstructMessage,
    type RelayMessage,
    type ProgressMessage,
} from "../../transport/protocol.js";

async function main() {
    console.log("\nProtocol Enrichment:");

    // === Targeting on all message types ===

    await test("NudgeMessage with to field validates and serializes", async () => {
        const msg: NudgeMessage = { type: "nudge", reason: "found something", to: "agent-a1" };
        assert(validateClientMessage(msg), "nudge with to is valid");
        const json = JSON.parse(serialize(msg).trim());
        assertEqual(json.to, "agent-a1", "to field preserved");
        assertEqual(json.reason, "found something", "reason preserved");
    });

    await test("NudgeMessage with swarm field validates", async () => {
        const msg: NudgeMessage = { type: "nudge", reason: "team update", swarm: "research" };
        assert(validateClientMessage(msg), "nudge with swarm is valid");
        const json = JSON.parse(serialize(msg).trim());
        assertEqual(json.swarm, "research", "swarm field preserved");
    });

    await test("BlockerMessage with to field validates", async () => {
        const msg: BlockerMessage = { type: "blocker", description: "stuck on X", to: "coordinator" };
        assert(validateClientMessage(msg), "blocker with to is valid");
        const target = getMessageTarget(msg);
        assertEqual(target.to, "coordinator", "target extracted");
    });

    await test("DoneMessage with to field validates", async () => {
        const msg: DoneMessage = { type: "done", summary: "task complete", to: "queen" };
        assert(validateClientMessage(msg), "done with to is valid");
    });

    await test("InstructMessage with to field validates (existing)", async () => {
        const msg: InstructMessage = { type: "instruct", instruction: "do this", to: "a1" };
        assert(validateClientMessage(msg), "instruct with to still valid");
    });

    await test("getMessageTarget extracts targeting from any message", async () => {
        const t1 = getMessageTarget({ type: "nudge", reason: "x", to: "a1" } as NudgeMessage);
        assertEqual(t1.to, "a1", "nudge target");
        assertEqual(t1.swarm, undefined, "no swarm");

        const t2 = getMessageTarget({ type: "blocker", description: "x", swarm: "s1" } as BlockerMessage);
        assertEqual(t2.swarm, "s1", "blocker swarm");

        const t3 = getMessageTarget({ type: "done", summary: "x" } as DoneMessage);
        assertEqual(t3.to, undefined, "no target");
        assertEqual(t3.swarm, undefined, "no swarm");
    });

    // === NudgeMessage payload ===

    await test("NudgeMessage with payload serializes correctly", async () => {
        const msg: NudgeMessage = {
            type: "nudge",
            reason: "updated findings",
            payload: {
                file: "/path/to/file.ts",
                snippet: "added new type definitions",
                section: "Findings",
                tags: ["protocol", "types"],
            },
        };
        assert(validateClientMessage(msg), "nudge with payload is valid");
        const json = JSON.parse(serialize(msg).trim());
        assertEqual(json.payload.file, "/path/to/file.ts", "file preserved");
        assertEqual(json.payload.snippet, "added new type definitions", "snippet preserved");
        assertEqual(json.payload.section, "Findings", "section preserved");
        assertEqual(json.payload.tags.length, 2, "tags preserved");
        assertEqual(json.payload.tags[0], "protocol", "first tag");
    });

    await test("NudgeMessage without payload still works", async () => {
        const msg: NudgeMessage = { type: "nudge", reason: "simple nudge" };
        assert(validateClientMessage(msg), "nudge without payload is valid");
        const json = JSON.parse(serialize(msg).trim());
        assertEqual(json.payload, undefined, "no payload");
    });

    await test("NudgeMessage with partial payload works", async () => {
        const msg: NudgeMessage = {
            type: "nudge",
            reason: "file update",
            payload: { file: "/some/path.ts" },
        };
        const json = JSON.parse(serialize(msg).trim());
        assertEqual(json.payload.file, "/some/path.ts", "file in partial payload");
        assertEqual(json.payload.snippet, undefined, "no snippet");
    });

    // === RelayMessage ===

    await test("RelayMessage validates", async () => {
        const msg: RelayMessage = {
            type: "relay",
            relay: {
                event: "register",
                name: "agent-a1",
                role: "agent",
                swarm: "research",
                code: "0.1.1",
            },
        };
        assert(validateClientMessage(msg), "relay message is valid");
    });

    await test("RelayMessage serializes with all fields", async () => {
        const msg: RelayMessage = {
            type: "relay",
            relay: {
                event: "done",
                name: "agent-a1",
                role: "agent",
                swarm: "research",
                code: "0.1.1",
                summary: "completed analysis",
            },
        };
        const json = JSON.parse(serialize(msg).trim());
        assertEqual(json.type, "relay", "type is relay");
        assertEqual(json.relay.event, "done", "event type");
        assertEqual(json.relay.name, "agent-a1", "agent name");
        assertEqual(json.relay.summary, "completed analysis", "summary");
    });

    await test("RelayMessage with blocked event", async () => {
        const msg: RelayMessage = {
            type: "relay",
            relay: {
                event: "blocked",
                name: "agent-b1",
                role: "agent",
                swarm: "impl",
                code: "0.2.1",
                description: "missing dependency",
            },
        };
        const json = JSON.parse(serialize(msg).trim());
        assertEqual(json.relay.event, "blocked", "blocked event");
        assertEqual(json.relay.description, "missing dependency", "description");
    });

    await test("RelayMessage rejects invalid (missing relay field)", async () => {
        assert(!validateClientMessage({ type: "relay" }), "relay without relay field invalid");
        assert(!validateClientMessage({ type: "relay", relay: null }), "relay with null invalid");
    });

    // === ProgressMessage ===

    await test("ProgressMessage validates with all fields", async () => {
        const msg: ProgressMessage = {
            type: "progress",
            phase: "running tests",
            percent: 75,
            detail: "15/20 tests passed",
        };
        assert(validateClientMessage(msg), "progress with all fields valid");
    });

    await test("ProgressMessage validates with no optional fields", async () => {
        const msg: ProgressMessage = { type: "progress" };
        assert(validateClientMessage(msg), "empty progress is valid");
    });

    await test("ProgressMessage serializes correctly", async () => {
        const msg: ProgressMessage = {
            type: "progress",
            phase: "reading files",
            percent: 30,
        };
        const json = JSON.parse(serialize(msg).trim());
        assertEqual(json.type, "progress", "type");
        assertEqual(json.phase, "reading files", "phase");
        assertEqual(json.percent, 30, "percent");
        assertEqual(json.detail, undefined, "no detail");
    });

    await test("ProgressMessage with only detail", async () => {
        const msg: ProgressMessage = {
            type: "progress",
            detail: "compiling TypeScript",
        };
        const json = JSON.parse(serialize(msg).trim());
        assertEqual(json.detail, "compiling TypeScript", "detail only");
    });

    // === Validation for new types in validateClientMessage ===

    await test("validateClientMessage accepts all new types", async () => {
        assert(validateClientMessage({ type: "relay", relay: { event: "register", name: "a", role: "agent", swarm: "s", code: "0.1" } }), "relay");
        assert(validateClientMessage({ type: "progress" }), "empty progress");
        assert(validateClientMessage({ type: "progress", phase: "x", percent: 50 }), "progress with fields");
    });

    await test("validateClientMessage still rejects unknown types", async () => {
        assert(!validateClientMessage({ type: "unknown" }), "unknown type");
        assert(!validateClientMessage({ type: "relay_old" }), "old relay type");
    });
}

main().then(() => summarize());
