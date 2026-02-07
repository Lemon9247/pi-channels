import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isValidMessage } from "../src/message.js";

describe("isValidMessage", () => {
    it("accepts a valid message with to and msg", () => {
        assert.ok(isValidMessage({ to: "general", msg: "hello" }));
    });

    it("accepts a valid message with data", () => {
        assert.ok(isValidMessage({ to: "a1", msg: "test", data: { x: 1 } }));
    });

    it("accepts data with nested objects", () => {
        assert.ok(isValidMessage({ to: "a", msg: "b", data: { nested: { deep: true } } }));
    });

    it("rejects null", () => {
        assert.ok(!isValidMessage(null));
    });

    it("rejects undefined", () => {
        assert.ok(!isValidMessage(undefined));
    });

    it("rejects arrays", () => {
        assert.ok(!isValidMessage([]));
    });

    it("rejects strings", () => {
        assert.ok(!isValidMessage("hello"));
    });

    it("rejects numbers", () => {
        assert.ok(!isValidMessage(42));
    });

    it("rejects missing to", () => {
        assert.ok(!isValidMessage({ msg: "hello" }));
    });

    it("rejects missing msg", () => {
        assert.ok(!isValidMessage({ to: "general" }));
    });

    it("rejects empty to", () => {
        assert.ok(!isValidMessage({ to: "", msg: "hello" }));
    });

    it("rejects empty msg", () => {
        assert.ok(!isValidMessage({ to: "general", msg: "" }));
    });

    it("rejects non-string to", () => {
        assert.ok(!isValidMessage({ to: 123, msg: "hello" }));
    });

    it("rejects non-string msg", () => {
        assert.ok(!isValidMessage({ to: "general", msg: 123 }));
    });

    it("rejects data as null", () => {
        assert.ok(!isValidMessage({ to: "a", msg: "b", data: null }));
    });

    it("rejects data as array", () => {
        assert.ok(!isValidMessage({ to: "a", msg: "b", data: [1, 2] }));
    });

    it("rejects data as string", () => {
        assert.ok(!isValidMessage({ to: "a", msg: "b", data: "nope" }));
    });

    it("accepts extra fields (pass-through)", () => {
        // Extra fields beyond to/msg/data don't invalidate
        assert.ok(isValidMessage({ to: "a", msg: "b", extra: "stuff" }));
    });
});
