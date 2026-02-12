/**
 * Tests for core/identity.ts
 *
 * Verifies identity creation, channel path helpers, and singleton behavior.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import {
    createIdentity,
    getIdentity,
    resetIdentity,
    getChannelGroupPath,
    getInboxChannel,
    getSubscribeChannels,
} from "../../core/identity.js";

describe("identity", () => {
    // Save and restore env vars
    const savedEnv: Record<string, string | undefined> = {};
    const envKeys = [
        "PI_CHANNELS_GROUP", "PI_CHANNELS_INBOX", "PI_CHANNELS_SUBSCRIBE",
        "PI_CHANNELS_NAME", "PI_SWARM_AGENT_NAME", "PI_SWARM_AGENT_ROLE",
        "PI_SWARM_AGENT_SWARM",
    ];

    beforeEach(() => {
        for (const key of envKeys) {
            savedEnv[key] = process.env[key];
            delete process.env[key];
        }
        resetIdentity();
    });

    afterEach(() => {
        for (const key of envKeys) {
            if (savedEnv[key] !== undefined) {
                process.env[key] = savedEnv[key];
            } else {
                delete process.env[key];
            }
        }
        resetIdentity();
    });

    describe("createIdentity", () => {
        it("defaults to queen when no env vars set", () => {
            const id = createIdentity();
            assert.equal(id.name, "queen");
            assert.equal(id.role, "queen");
            assert.equal(id.swarm, undefined);
        });

        it("reads from PI_CHANNELS_NAME", () => {
            process.env.PI_CHANNELS_NAME = "agent a1";
            const id = createIdentity();
            assert.equal(id.name, "agent a1");
        });

        it("falls back to PI_SWARM_AGENT_NAME if PI_CHANNELS_NAME not set", () => {
            process.env.PI_SWARM_AGENT_NAME = "agent b2";
            const id = createIdentity();
            assert.equal(id.name, "agent b2");
        });

        it("prefers PI_CHANNELS_NAME over PI_SWARM_AGENT_NAME", () => {
            process.env.PI_CHANNELS_NAME = "channels-name";
            process.env.PI_SWARM_AGENT_NAME = "legacy-name";
            const id = createIdentity();
            assert.equal(id.name, "channels-name");
        });

        it("reads role and swarm from env", () => {
            process.env.PI_SWARM_AGENT_ROLE = "agent";
            process.env.PI_SWARM_AGENT_SWARM = "test-swarm";
            const id = createIdentity();
            assert.equal(id.role, "agent");
            assert.equal(id.swarm, "test-swarm");
        });

        it("caches the identity singleton", () => {
            const id1 = createIdentity();
            process.env.PI_CHANNELS_NAME = "changed";
            const id2 = createIdentity();
            assert.equal(id1, id2); // Same reference
            assert.equal(id2.name, "queen"); // Not changed
        });
    });

    describe("getIdentity", () => {
        it("creates identity if not yet initialized", () => {
            const id = getIdentity();
            assert.equal(id.name, "queen");
        });
    });

    describe("getChannelGroupPath", () => {
        it("returns undefined when not in a swarm", () => {
            assert.equal(getChannelGroupPath(), undefined);
        });

        it("returns the path when PI_CHANNELS_GROUP is set", () => {
            process.env.PI_CHANNELS_GROUP = "/tmp/pi-swarm/test123";
            assert.equal(getChannelGroupPath(), "/tmp/pi-swarm/test123");
        });
    });

    describe("getInboxChannel", () => {
        it("returns undefined when not set", () => {
            assert.equal(getInboxChannel(), undefined);
        });

        it("returns channel name when set", () => {
            process.env.PI_CHANNELS_INBOX = "inbox-agent-a1";
            assert.equal(getInboxChannel(), "inbox-agent-a1");
        });
    });

    describe("getSubscribeChannels", () => {
        it("defaults to [general] when not set", () => {
            assert.deepEqual(getSubscribeChannels(), ["general"]);
        });

        it("parses comma-separated list", () => {
            process.env.PI_CHANNELS_SUBSCRIBE = "general,inbox-coord";
            assert.deepEqual(getSubscribeChannels(), ["general", "inbox-coord"]);
        });

        it("trims whitespace", () => {
            process.env.PI_CHANNELS_SUBSCRIBE = " general , inbox-coord ";
            assert.deepEqual(getSubscribeChannels(), ["general", "inbox-coord"]);
        });
    });

    describe("resetIdentity", () => {
        it("allows re-creation after reset", () => {
            createIdentity();
            resetIdentity();
            process.env.PI_CHANNELS_NAME = "new-agent";
            const id = createIdentity();
            assert.equal(id.name, "new-agent");
        });
    });
});
