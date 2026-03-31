import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { detectTerminal } from "../extensions/channels/terminal.js";

describe("terminal detection", () => {
    const origEnv = { ...process.env };

    afterEach(() => {
        // Restore env
        for (const key of Object.keys(process.env)) {
            if (!(key in origEnv)) {
                delete process.env[key];
            }
        }
        for (const [key, val] of Object.entries(origEnv)) {
            process.env[key] = val;
        }
    });

    it("returns preference when not auto", () => {
        assert.equal(detectTerminal("tmux"), "tmux");
        assert.equal(detectTerminal("kitty"), "kitty");
    });

    it("detects tmux from TMUX env", () => {
        process.env.TMUX = "/tmp/tmux-1000/default,12345,0";
        assert.equal(detectTerminal("auto"), "tmux");
    });

    it("detects kitty from KITTY_PID env", () => {
        delete process.env.TMUX;
        process.env.KITTY_PID = "12345";
        assert.equal(detectTerminal("auto"), "kitty");
    });

    it("detects iTerm2 from TERM_PROGRAM", () => {
        delete process.env.TMUX;
        delete process.env.KITTY_PID;
        process.env.TERM_PROGRAM = "iTerm.app";
        assert.equal(detectTerminal("auto"), "iterm2");
    });
});
