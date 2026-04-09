import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as path from "node:path";
import * as reservations from "../extensions/channels/reservations.js";
import * as registry from "../extensions/channels/registry.js";

describe("reservations", () => {
    const projectDir = path.join("/tmp", "pi-channels-reservations-test");

    function clear(): void {
        registry.unregisterAgent("Alpha");
        registry.unregisterAgent("Beta");
    }

    it("creates reservation objects", () => {
        const reservation = reservations.createReservation("Alpha", ["src/auth/"], "Refactoring auth");
        assert.deepEqual(reservation.paths, ["src/auth/"]);
        assert.equal(reservation.reason, "Refactoring auth");
        assert.equal(reservation.agent, "Alpha");
    });

    it("detects exact path conflicts via registry", () => {
        clear();
        registry.registerAgent({
            name: "Alpha",
            pid: process.pid,
            cwd: projectDir,
            reservations: [reservations.createReservation("Alpha", ["src/auth/login.ts"], "Working on login")],
            joinedAt: new Date().toISOString(),
            lastActivity: new Date().toISOString(),
            status: "active",
            channels: ["general"],
        });

        const conflict = reservations.checkConflict("src/auth/login.ts", "Beta", projectDir);
        assert.ok(conflict);
        assert.equal(conflict!.agent, "Alpha");
        clear();
    });

    it("detects directory reservation conflicts", () => {
        clear();
        registry.registerAgent({
            name: "Alpha",
            pid: process.pid,
            cwd: projectDir,
            reservations: [reservations.createReservation("Alpha", ["src/auth/"], "Refactoring auth")],
            joinedAt: new Date().toISOString(),
            lastActivity: new Date().toISOString(),
            status: "active",
            channels: ["general"],
        });

        const conflict = reservations.checkConflict("src/auth/login.ts", "Beta", projectDir);
        assert.ok(conflict);
        assert.equal(conflict!.agent, "Alpha");
        clear();
    });

    it("ignores your own reservations", () => {
        clear();
        registry.registerAgent({
            name: "Alpha",
            pid: process.pid,
            cwd: projectDir,
            reservations: [reservations.createReservation("Alpha", ["src/auth/"], "Refactoring auth")],
            joinedAt: new Date().toISOString(),
            lastActivity: new Date().toISOString(),
            status: "active",
            channels: ["general"],
        });

        const conflict = reservations.checkConflict("src/auth/login.ts", "Alpha", projectDir);
        assert.equal(conflict, null);
        clear();
    });

    it("adds new reservations to an existing list", () => {
        const existing = [reservations.createReservation("Alpha", ["src/auth/"], "Auth")];
        const next = reservations.addReservation(existing, "Alpha", ["src/api/"], "API");
        assert.equal(next.length, 2);
        assert.deepEqual(next[1]!.paths, ["src/api/"]);
    });

    it("releases specific paths", () => {
        const existing = [reservations.createReservation("Alpha", ["src/auth/", "src/api/"], "Working")];
        const { kept, released } = reservations.releaseReservations(existing, ["src/auth/"]);
        assert.equal(released.length, 1);
        assert.equal(kept.length, 1);
        assert.deepEqual(kept[0]!.paths, ["src/api/"]);
    });

    it("releases everything when no paths are specified", () => {
        const existing = [
            reservations.createReservation("Alpha", ["src/auth/"], "Auth"),
            reservations.createReservation("Alpha", ["src/api/"], "API"),
        ];
        const { kept, released } = reservations.releaseReservations(existing);
        assert.equal(kept.length, 0);
        assert.equal(released.length, 2);
    });
});
