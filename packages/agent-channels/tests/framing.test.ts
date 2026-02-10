import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { encode, FrameDecoder } from "../src/framing.js";
import type { Message } from "../src/message.js";

describe("encode", () => {
    it("produces a 4-byte length prefix followed by JSON", () => {
        const msg: Message = { msg: "hello" };
        const frame = encode(msg);
        const len = frame.readUInt32BE(0);
        const json = frame.subarray(4).toString("utf-8");
        assert.equal(len, frame.length - 4);
        assert.deepEqual(JSON.parse(json), msg);
    });

    it("includes data field when present", () => {
        const msg: Message = { msg: "test", data: { x: 42 } };
        const frame = encode(msg);
        const json = frame.subarray(4).toString("utf-8");
        assert.deepEqual(JSON.parse(json), msg);
    });
});

describe("FrameDecoder", () => {
    it("decodes a single complete frame", () => {
        const decoder = new FrameDecoder();
        const msg: Message = { msg: "hello" };
        const messages = decoder.push(encode(msg));
        assert.equal(messages.length, 1);
        assert.deepEqual(messages[0], msg);
    });

    it("decodes multiple frames in a single chunk", () => {
        const decoder = new FrameDecoder();
        const msg1: Message = { msg: "one" };
        const msg2: Message = { msg: "two" };
        const msg3: Message = { msg: "three" };
        const combined = Buffer.concat([encode(msg1), encode(msg2), encode(msg3)]);
        const messages = decoder.push(combined);
        assert.equal(messages.length, 3);
        assert.deepEqual(messages[0], msg1);
        assert.deepEqual(messages[1], msg2);
        assert.deepEqual(messages[2], msg3);
    });

    it("handles partial reads — length header split", () => {
        const decoder = new FrameDecoder();
        const frame = encode({ msg: "partial" });

        let messages = decoder.push(frame.subarray(0, 2));
        assert.equal(messages.length, 0);

        messages = decoder.push(frame.subarray(2));
        assert.equal(messages.length, 1);
        assert.equal(messages[0]!.msg, "partial");
    });

    it("handles partial reads — body split", () => {
        const decoder = new FrameDecoder();
        const frame = encode({ msg: "split body test" });

        let messages = decoder.push(frame.subarray(0, 8));
        assert.equal(messages.length, 0);

        messages = decoder.push(frame.subarray(8));
        assert.equal(messages.length, 1);
        assert.equal(messages[0]!.msg, "split body test");
    });

    it("handles byte-at-a-time feeding", () => {
        const decoder = new FrameDecoder();
        const msg: Message = { msg: "byte by byte" };
        const frame = encode(msg);

        let messages: Message[] = [];
        for (let i = 0; i < frame.length; i++) {
            messages = decoder.push(frame.subarray(i, i + 1));
            if (i < frame.length - 1) {
                assert.equal(messages.length, 0);
            }
        }
        assert.equal(messages.length, 1);
        assert.deepEqual(messages[0], msg);
    });

    it("throws on oversized message", () => {
        const decoder = new FrameDecoder(10);
        const msg: Message = { msg: "this message is way too large for the limit" };
        const frame = encode(msg);

        assert.throws(() => decoder.push(frame), /exceeds maximum/);
    });

    it("resets buffer after oversized message error", () => {
        const decoder = new FrameDecoder(50);
        const smallMsg: Message = { msg: "b" };
        let messages = decoder.push(encode(smallMsg));
        assert.equal(messages.length, 1);

        const oversizedFrame = Buffer.alloc(4);
        oversizedFrame.writeUInt32BE(999999, 0);
        assert.throws(() => decoder.push(oversizedFrame), /exceeds maximum/);

        messages = decoder.push(encode(smallMsg));
        assert.equal(messages.length, 1);
        assert.deepEqual(messages[0], smallMsg);
    });

    it("throws on invalid JSON", () => {
        const decoder = new FrameDecoder();
        const badJson = Buffer.from("not json{{{", "utf-8");
        const frame = Buffer.alloc(4 + badJson.length);
        frame.writeUInt32BE(badJson.length, 0);
        badJson.copy(frame, 4);

        assert.throws(() => decoder.push(frame), /Invalid JSON/);
    });

    it("throws on valid JSON that isn't a valid Message", () => {
        const decoder = new FrameDecoder();
        const json = Buffer.from(JSON.stringify({ foo: "bar" }), "utf-8");
        const frame = Buffer.alloc(4 + json.length);
        frame.writeUInt32BE(json.length, 0);
        json.copy(frame, 4);

        assert.throws(() => decoder.push(frame), /Invalid message format/);
    });

    it("throws on Message with empty msg field", () => {
        const decoder = new FrameDecoder();
        const json = Buffer.from(JSON.stringify({ msg: "" }), "utf-8");
        const frame = Buffer.alloc(4 + json.length);
        frame.writeUInt32BE(json.length, 0);
        json.copy(frame, 4);

        assert.throws(() => decoder.push(frame), /Invalid message format/);
    });

    it("reset clears internal buffer", () => {
        const decoder = new FrameDecoder();
        const msg: Message = { msg: "test" };
        const frame = encode(msg);

        decoder.push(frame.subarray(0, 3));
        decoder.reset();

        const messages = decoder.push(encode(msg));
        assert.equal(messages.length, 1);
        assert.deepEqual(messages[0], msg);
    });
});
