import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { ChannelGroup } from "../src/group.js";
import { ChannelClient } from "../src/client.js";
import type { Message } from "../src/message.js";

function tmpGroupPath(): string {
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "grp-test-")), "group");
}

const cleanupItems: Array<{ stop?: (opts?: any) => Promise<void>; disconnect?: () => void }> = [];

afterEach(async () => {
    for (const item of cleanupItems) {
        try {
            if (item.disconnect) item.disconnect();
            if (item.stop) await item.stop({ removeDir: true });
        } catch { /* ignore */ }
    }
    cleanupItems.length = 0;
});

function track<T extends { stop?: (opts?: any) => Promise<void>; disconnect?: () => void }>(item: T): T {
    cleanupItems.push(item as any);
    return item;
}

describe("ChannelGroup", () => {
    it("creates directory and starts all channels", async () => {
        const groupPath = tmpGroupPath();
        const group = track(new ChannelGroup({
            path: groupPath,
            channels: [
                { name: "general" },
                { name: "inbox-a1", inbox: true },
                { name: "inbox-a2", inbox: true },
            ],
        }));

        await group.start();
        assert.ok(group.started);
        assert.ok(fs.existsSync(groupPath));
        assert.ok(fs.existsSync(path.join(groupPath, "general.sock")));
        assert.ok(fs.existsSync(path.join(groupPath, "inbox-a1.sock")));
        assert.ok(fs.existsSync(path.join(groupPath, "inbox-a2.sock")));

        await group.stop({ removeDir: true });
    });

    it("writes group.json after all channels are listening", async () => {
        const groupPath = tmpGroupPath();
        const group = track(new ChannelGroup({
            path: groupPath,
            channels: [
                { name: "general" },
                { name: "inbox-a1", inbox: true },
            ],
        }));

        await group.start();

        const metaPath = path.join(groupPath, "group.json");
        assert.ok(fs.existsSync(metaPath));

        const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
        assert.ok(meta.created);
        assert.equal(meta.pid, process.pid);
        assert.equal(meta.channels.length, 2);
        assert.deepEqual(meta.channels[0], { name: "general" });
        assert.deepEqual(meta.channels[1], { name: "inbox-a1", inbox: true });

        await group.stop({ removeDir: true });
    });

    it("list returns all channel names", async () => {
        const groupPath = tmpGroupPath();
        const group = track(new ChannelGroup({
            path: groupPath,
            channels: [{ name: "a" }, { name: "b" }, { name: "c" }],
        }));

        await group.start();
        const names = group.list();
        assert.deepEqual(names.sort(), ["a", "b", "c"]);

        await group.stop({ removeDir: true });
    });

    it("channel() returns a channel by name", async () => {
        const groupPath = tmpGroupPath();
        const group = track(new ChannelGroup({
            path: groupPath,
            channels: [{ name: "general" }],
        }));

        await group.start();
        const ch = group.channel("general");
        assert.ok(ch);
        assert.ok(ch.started);

        await group.stop({ removeDir: true });
    });

    it("channel() throws for unknown name", async () => {
        const groupPath = tmpGroupPath();
        const group = track(new ChannelGroup({
            path: groupPath,
            channels: [{ name: "general" }],
        }));

        await group.start();
        assert.throws(() => group.channel("nonexistent"), /not found/);

        await group.stop({ removeDir: true });
    });

    it("clients can communicate through group channels", async () => {
        const groupPath = tmpGroupPath();
        const group = track(new ChannelGroup({
            path: groupPath,
            channels: [{ name: "general" }],
        }));

        await group.start();

        const client1 = track(new ChannelClient(path.join(groupPath, "general.sock")));
        const client2 = track(new ChannelClient(path.join(groupPath, "general.sock")));
        await client1.connect();
        await client2.connect();

        const received: Message[] = [];
        client2.on("message", (msg: Message) => received.push(msg));

        client1.send({ to: "general", msg: "hello through group" });
        await new Promise((r) => setTimeout(r, 50));

        assert.equal(received.length, 1);
        assert.equal(received[0]!.msg, "hello through group");

        client1.disconnect();
        client2.disconnect();
        await group.stop({ removeDir: true });
    });

    it("addChannel adds a channel to a running group", async () => {
        const groupPath = tmpGroupPath();
        const group = track(new ChannelGroup({
            path: groupPath,
            channels: [{ name: "general" }],
        }));

        await group.start();
        assert.equal(group.list().length, 1);

        const newChannel = await group.addChannel({ name: "topic-new" });
        assert.ok(newChannel.started);
        assert.equal(group.list().length, 2);
        assert.ok(group.list().includes("topic-new"));

        // Verify group.json is updated
        const meta = JSON.parse(fs.readFileSync(path.join(groupPath, "group.json"), "utf-8"));
        assert.equal(meta.channels.length, 2);

        // Verify clients can connect to the new channel
        const client = track(new ChannelClient(path.join(groupPath, "topic-new.sock")));
        await client.connect();
        assert.ok(client.connected);

        client.disconnect();
        await group.stop({ removeDir: true });
    });

    it("addChannel throws for duplicate name", async () => {
        const groupPath = tmpGroupPath();
        const group = track(new ChannelGroup({
            path: groupPath,
            channels: [{ name: "general" }],
        }));

        await group.start();
        await assert.rejects(() => group.addChannel({ name: "general" }), /already exists/);

        await group.stop({ removeDir: true });
    });

    it("addChannel throws when group not started", async () => {
        const group = new ChannelGroup({
            path: tmpGroupPath(),
            channels: [{ name: "general" }],
        });

        await assert.rejects(() => group.addChannel({ name: "new" }), /not started/);
    });

    it("stop cleans up socket files", async () => {
        const groupPath = tmpGroupPath();
        const group = new ChannelGroup({
            path: groupPath,
            channels: [{ name: "a" }, { name: "b" }],
        });

        await group.start();
        assert.ok(fs.existsSync(path.join(groupPath, "a.sock")));

        await group.stop();
        assert.ok(!fs.existsSync(path.join(groupPath, "a.sock")));
        assert.ok(!fs.existsSync(path.join(groupPath, "b.sock")));
        assert.ok(!fs.existsSync(path.join(groupPath, "group.json")));
        // Directory itself still exists (removeDir not set)
        assert.ok(fs.existsSync(groupPath));
    });

    it("stop with removeDir removes the directory", async () => {
        const groupPath = tmpGroupPath();
        const group = new ChannelGroup({
            path: groupPath,
            channels: [{ name: "a" }],
        });

        await group.start();
        await group.stop({ removeDir: true });
        assert.ok(!fs.existsSync(groupPath));
    });

    it("stop disconnects connected clients", async () => {
        const groupPath = tmpGroupPath();
        const group = track(new ChannelGroup({
            path: groupPath,
            channels: [{ name: "general" }],
        }));

        await group.start();

        const client = new ChannelClient(path.join(groupPath, "general.sock"));
        await client.connect();

        const disconnectPromise = new Promise<void>((resolve) => {
            client.on("disconnect", resolve);
        });

        await group.stop({ removeDir: true });
        await disconnectPromise;
        assert.equal(client.connected, false);
    });

    it("throws on double start", async () => {
        const groupPath = tmpGroupPath();
        const group = track(new ChannelGroup({
            path: groupPath,
            channels: [{ name: "a" }],
        }));

        await group.start();
        await assert.rejects(() => group.start(), /already started/);

        await group.stop({ removeDir: true });
    });

    it("stop is idempotent", async () => {
        const groupPath = tmpGroupPath();
        const group = new ChannelGroup({
            path: groupPath,
            channels: [{ name: "a" }],
        });

        await group.start();
        await group.stop({ removeDir: true });
        await group.stop({ removeDir: true }); // Should not throw
    });

    it("exposes path property", () => {
        const groupPath = "/tmp/test-group";
        const group = new ChannelGroup({ path: groupPath, channels: [] });
        assert.equal(group.path, groupPath);
    });
});
