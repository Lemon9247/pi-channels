import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { generateName, generateUniqueName } from "../extensions/channels/names.js";

describe("generateName", () => {
    it("creatures theme produces non-empty string", () => {
        const name = generateName("creatures");
        assert.ok(name.length > 0);
    });

    it("nature theme produces non-empty string", () => {
        const name = generateName("nature");
        assert.ok(name.length > 0);
    });

    it("space theme produces non-empty string", () => {
        const name = generateName("space");
        assert.ok(name.length > 0);
    });

    it("minimal theme produces greek letter", () => {
        const name = generateName("minimal");
        const greekLetters = [
            "Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta", "Eta",
            "Theta", "Iota", "Kappa", "Lambda", "Mu", "Nu", "Xi",
            "Omicron", "Pi", "Rho", "Sigma", "Tau", "Upsilon",
        ];
        assert.ok(greekLetters.includes(name), `Expected greek letter, got: ${name}`);
    });

    it("classic theme produces non-empty string", () => {
        const name = generateName("classic");
        assert.ok(name.length > 0);
    });

    it("custom theme with words works", () => {
        const name = generateName("custom", { adj: ["Test"], noun: ["Name"] });
        assert.equal(name, "TestName");
    });

    it("custom theme without words falls back to creatures", () => {
        const name = generateName("custom", null);
        assert.ok(name.length > 0);
    });
});

describe("generateUniqueName", () => {
    it("generates name not in existing set", () => {
        const existing = new Set(["Alpha", "Beta"]);
        const name = generateUniqueName("minimal", existing);
        assert.ok(!existing.has(name) || name.match(/\d$/), `Name should be unique, got: ${name}`);
    });

    it("appends suffix on collision", () => {
        // Fill up all greek letters to force collision
        const greekLetters = [
            "Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta", "Eta",
            "Theta", "Iota", "Kappa", "Lambda", "Mu", "Nu", "Xi",
            "Omicron", "Pi", "Rho", "Sigma", "Tau", "Upsilon",
        ];
        const existing = new Set(greekLetters);
        const name = generateUniqueName("minimal", existing);
        // Should have a numeric suffix
        assert.ok(name.match(/\d+$/), `Expected numeric suffix, got: ${name}`);
    });
});
