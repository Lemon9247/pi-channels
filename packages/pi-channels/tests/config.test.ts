import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { shouldAutoRegister } from "../extensions/channels/config.js";
import { DEFAULT_CONFIG, type ChannelsConfig } from "../extensions/channels/types.js";

describe("shouldAutoRegister", () => {
    it("returns true by default (autoRegister: true)", () => {
        assert.equal(shouldAutoRegister(DEFAULT_CONFIG, "/some/path"), true);
    });

    it("returns false when autoRegister is explicitly false", () => {
        const config = { ...DEFAULT_CONFIG, autoRegister: false };
        assert.equal(shouldAutoRegister(config, "/any/path"), false);
    });

    it("returns true when PI_CHANNELS_AUTO_REGISTER=1", () => {
        const orig = process.env.PI_CHANNELS_AUTO_REGISTER;
        process.env.PI_CHANNELS_AUTO_REGISTER = "1";
        try {
            assert.equal(shouldAutoRegister(DEFAULT_CONFIG, "/any/path"), true);
        } finally {
            if (orig === undefined) delete process.env.PI_CHANNELS_AUTO_REGISTER;
            else process.env.PI_CHANNELS_AUTO_REGISTER = orig;
        }
    });

    it("matches exact path in autoRegisterPaths (when autoRegister is false)", () => {
        const config = { ...DEFAULT_CONFIG, autoRegister: false, autoRegisterPaths: ["/projects/team"] };
        assert.equal(shouldAutoRegister(config, "/projects/team"), true);
        assert.equal(shouldAutoRegister(config, "/projects/other"), false);
    });

    it("matches subdirectory of path in autoRegisterPaths (when autoRegister is false)", () => {
        const config = { ...DEFAULT_CONFIG, autoRegister: false, autoRegisterPaths: ["/projects/team"] };
        assert.equal(shouldAutoRegister(config, "/projects/team/subdir"), true);
    });

    it("matches glob pattern with /* (when autoRegister is false)", () => {
        const config = { ...DEFAULT_CONFIG, autoRegister: false, autoRegisterPaths: ["/projects/*"] };
        assert.equal(shouldAutoRegister(config, "/projects/team"), true);
        assert.equal(shouldAutoRegister(config, "/projects/team/sub"), true);
        assert.equal(shouldAutoRegister(config, "/other"), false);
    });

    it("expands ~ in paths (when autoRegister is false)", () => {
        const home = os.homedir();
        const config = { ...DEFAULT_CONFIG, autoRegister: false, autoRegisterPaths: [`~/projects`] };
        assert.equal(shouldAutoRegister(config, `${home}/projects`), true);
    });
});
