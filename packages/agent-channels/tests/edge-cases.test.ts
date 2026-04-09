import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as net from "node:net";
import { Channel } from "../src/channel.js";
import type { Message } from "../src/message.js";

function tmpSocketPath(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "edge-test-"));
    return path.join(dir, "test.sock");
}

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

const cleanup: Array<{ leave?: () => Promise<void>; destroy?: () => void }> = [];

afterEach(async () => {
    for (const item of cleanup) {
        try {
            item.destroy?.();
            await item.leave?.();
        } catch {
            // ignore
        }
    }
    cleanup.length = 0;
});

function track<T extends Record<string, unknown>>(item: T): T {
    cleanup.push(item as { leave?: () => Promise<void>; destroy?: () => void });
    return item;
}

describe("edge cases", () => {
    it("handles malformed client data without killing the server", async () => {
        const socketPath = tmpSocketPath();
        const channel = track(new Channel({ path: socketPath, name: "Alpha" }));
        await channel.join();

        const errors: Error[] = [];
        channel.on("error", (err: Error) => errors.push(err));

        const rawSocket = track(net.connect(socketPath));
        await new Promise<void>((resolve) => rawSocket.on("connect", resolve));

        const badPayload = Buffer.from("not json at all!!!", "utf-8");
        const frame = Buffer.alloc(4 + badPayload.length);
        frame.writeUInt32BE(badPayload.length, 0);
        badPayload.copy(frame, 4);
        rawSocket.write(frame);

        await wait(100);

        assert.ok(channel.joined);
        assert.ok(errors.length > 0);
    });

    it("survives one client disconnecting during fan-out", async () => {
        const socketPath = tmpSocketPath();
        const alpha = track(new Channel({ path: socketPath, name: "Alpha" }));
        const beta = track(new Channel({ path: socketPath, name: "Beta" }));
        const gamma = track(new Channel({ path: socketPath, name: "Gamma" }));
        await alpha.join();
        await beta.join();
        await gamma.join();
        await wait(150);

        await beta.leave();
        await wait(50);

        const received: Message[] = [];
        gamma.on("message", (msg) => received.push(msg));

        alpha.send({ msg: "after disconnect" });
        await wait(100);

        assert.equal(received.length, 1);
        assert.equal(received[0]!.msg, "after disconnect");
        assert.ok(alpha.joined);
    });

    it("delivers large messages", async () => {
        const socketPath = tmpSocketPath();
        const alpha = track(new Channel({ path: socketPath, name: "Alpha" }));
        const beta = track(new Channel({ path: socketPath, name: "Beta" }));
        await alpha.join();
        await beta.join();
        await wait(150);

        const received: Message[] = [];
        beta.on("message", (msg) => received.push(msg));

        const largeData: Record<string, string> = {};
        for (let i = 0; i < 1000; i++) {
            largeData[`key-${i}`] = "x".repeat(100);
        }

        alpha.send({ msg: "large message", data: largeData });
        await wait(200);

        assert.equal(received.length, 1);
        assert.equal(received[0]!.msg, "large message");
        assert.equal(Object.keys(received[0]!.data ?? {}).length, 1001);
    });
});
