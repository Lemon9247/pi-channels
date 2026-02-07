/**
 * Protocol tests: serialization, parseLines, validation
 */

import { test, assert, assertEqual, summarize } from "../helpers.js";
import { parseLines, serialize, validateRegister, validateClientMessage, isRelayedMessage, normalizeRelayedMessage } from "../../transport/protocol.js";

async function main() {
    console.log("\nProtocol:");

    await test("serialize produces JSON line", async () => {
        const result = serialize({ type: "nudge", reason: "test" });
        assert(result.endsWith("\n"), "should end with newline");
        const parsed = JSON.parse(result.trim());
        assertEqual(parsed.type, "nudge", "type");
        assertEqual(parsed.reason, "test", "reason");
    });

    await test("parseLines handles complete lines", async () => {
        const input = '{"type":"nudge","reason":"a"}\n{"type":"done","summary":"b"}\n';
        const { messages, remainder } = parseLines(input);
        assertEqual(messages.length, 2, "should parse 2 messages");
        assertEqual(remainder, "", "no remainder");
    });

    await test("parseLines handles partial line", async () => {
        const input = '{"type":"nudge","reason":"a"}\n{"type":"do';
        const { messages, remainder } = parseLines(input);
        assertEqual(messages.length, 1, "should parse 1 message");
        assertEqual(remainder, '{"type":"do', "partial remainder");
    });

    await test("parseLines handles empty input", async () => {
        const { messages, remainder } = parseLines("");
        assertEqual(messages.length, 0, "no messages");
        assertEqual(remainder, "", "no remainder");
    });

    await test("parseLines skips malformed lines", async () => {
        const input = 'not json\n{"type":"nudge","reason":"ok"}\n';
        const { messages, remainder } = parseLines(input);
        assertEqual(messages.length, 1, "should parse 1 valid message");
    });

    await test("parseLines reassembles across chunks", async () => {
        const chunk1 = '{"type":"nud';
        const chunk2 = 'ge","reason":"split"}\n';
        const r1 = parseLines(chunk1);
        assertEqual(r1.messages.length, 0, "no complete messages in chunk1");
        const r2 = parseLines(r1.remainder + chunk2);
        assertEqual(r2.messages.length, 1, "reassembled message from chunks");
        assertEqual((r2.messages[0] as any).reason, "split", "correct content");
    });

    await test("validateRegister accepts valid queen", async () => {
        assert(validateRegister({ type: "register", name: "queen", role: "queen" }), "queen valid");
    });

    await test("validateRegister accepts valid agent with swarm", async () => {
        assert(
            validateRegister({ type: "register", name: "a1", role: "agent", swarm: "analysis" }),
            "agent with swarm valid",
        );
    });

    await test("validateRegister rejects agent without swarm", async () => {
        assert(!validateRegister({ type: "register", name: "a1", role: "agent" }), "agent without swarm invalid");
    });

    await test("validateRegister rejects empty name", async () => {
        assert(!validateRegister({ type: "register", name: "", role: "queen" }), "empty name invalid");
    });

    await test("validateClientMessage validates all types", async () => {
        assert(validateClientMessage({ type: "nudge", reason: "test" }), "nudge valid");
        assert(validateClientMessage({ type: "blocker", description: "stuck" }), "blocker valid");
        assert(validateClientMessage({ type: "done", summary: "finished" }), "done valid");
        assert(validateClientMessage({ type: "instruct", instruction: "do this" }), "instruct valid");
        assert(!validateClientMessage({ type: "unknown" }), "unknown type invalid");
        assert(!validateClientMessage(null), "null invalid");
    });

    console.log("\nnormalizeRelayedMessage:");

    await test("normalizes old format (from: string) to new (from: MessageSender)", async () => {
        const oldFormat: any = {
            from: "agent-1",
            fromRole: "agent",
            fromSwarm: "s1",
            message: { type: "nudge", reason: "test" },
        };
        assert(isRelayedMessage(oldFormat), "old format recognized as RelayedMessage");

        const normalized = normalizeRelayedMessage(oldFormat);
        assertEqual(typeof normalized.from, "object", "from is now an object");
        assertEqual(normalized.from.name, "agent-1", "name extracted");
        assertEqual(normalized.from.role, "agent", "role extracted");
        assertEqual(normalized.from.swarm, "s1", "swarm extracted");
        assertEqual(normalized.message.type, "nudge", "message preserved");
    });

    await test("passes through new format (from: MessageSender) unchanged", async () => {
        const newFormat: any = {
            from: { name: "agent-1", role: "agent", swarm: "s1" },
            message: { type: "done", summary: "finished" },
        };
        const normalized = normalizeRelayedMessage(newFormat);
        assertEqual(normalized.from.name, "agent-1", "name unchanged");
        assertEqual(normalized.from.role, "agent", "role unchanged");
        assertEqual(normalized.message.type, "done", "message unchanged");
    });

    await test("old format without fromRole defaults to agent", async () => {
        const oldFormat: any = {
            from: "agent-2",
            message: { type: "blocker", description: "stuck" },
        };
        const normalized = normalizeRelayedMessage(oldFormat);
        assertEqual(normalized.from.role, "agent", "defaults to agent role");
    });

    await test("old format without fromSwarm leaves swarm undefined", async () => {
        const oldFormat: any = {
            from: "queen-1",
            fromRole: "queen",
            message: { type: "nudge", reason: "hi" },
        };
        const normalized = normalizeRelayedMessage(oldFormat);
        assertEqual(normalized.from.swarm, undefined, "no swarm when absent");
    });
}

main().then(() => summarize());
