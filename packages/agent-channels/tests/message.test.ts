import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isValidMessage } from "../src/message.js";

describe("isValidMessage", () => {
    it("accepts a valid message with msg", () => {
        assert.ok(isValidMessage({ msg: "hello" }));
    });

    it("accepts a valid message with data", () => {
        assert.ok(isValidMessage({ msg: "test", data: { x: 1 } }));
    });

    it("accepts data with nested objects", () => {
        assert.ok(isValidMessage({ msg: "b", data: { nested: { deep: true } } }));
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

    it("rejects missing msg", () => {
        assert.ok(!isValidMessage({ data: { x: 1 } }));
    });

    it("rejects empty msg", () => {
        assert.ok(!isValidMessage({ msg: "" }));
    });

    it("rejects non-string msg", () => {
        assert.ok(!isValidMessage({ msg: 123 }));
    });

    it("rejects data as null", () => {
        assert.ok(!isValidMessage({ msg: "b", data: null }));
    });

    it("rejects data as array", () => {
        assert.ok(!isValidMessage({ msg: "b", data: [1, 2] }));
    });

    it("rejects data as string", () => {
        assert.ok(!isValidMessage({ msg: "b", data: "nope" }));
    });

    it("accepts extra fields (pass-through)", () => {
        assert.ok(isValidMessage({ msg: "b", extra: "stuff" }));
    });
});
