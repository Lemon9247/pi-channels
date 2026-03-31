import { describe, it, beforeEach } from "node:test";
import * as assert from "node:assert/strict";
import * as reservations from "../extensions/channels/reservations.js";

describe("reservations", () => {
    beforeEach(() => {
        reservations.clearAllReservations();
    });

    it("creates and retrieves reservations", () => {
        reservations.createReservation("Alpha", ["src/auth/"], "Refactoring auth");
        const res = reservations.getReservations("Alpha");
        assert.equal(res.length, 1);
        assert.deepEqual(res[0]!.paths, ["src/auth/"]);
        assert.equal(res[0]!.reason, "Refactoring auth");
    });

    it("detects conflict with exact path", () => {
        reservations.createReservation("Alpha", ["src/auth/login.ts"], "Working on login");
        const conflict = reservations.checkConflict("src/auth/login.ts", "Beta", "/project");
        assert.ok(conflict);
        assert.equal(conflict!.agent, "Alpha");
    });

    it("detects conflict with directory reservation", () => {
        reservations.createReservation("Alpha", ["src/auth/"], "Refactoring auth");
        const conflict = reservations.checkConflict("src/auth/login.ts", "Beta", "/project");
        assert.ok(conflict);
        assert.equal(conflict!.agent, "Alpha");
    });

    it("no conflict with own reservation", () => {
        reservations.createReservation("Alpha", ["src/auth/"], "Refactoring auth");
        const conflict = reservations.checkConflict("src/auth/login.ts", "Alpha", "/project");
        assert.equal(conflict, null);
    });

    it("no conflict with unrelated path", () => {
        reservations.createReservation("Alpha", ["src/auth/"], "Refactoring auth");
        const conflict = reservations.checkConflict("src/api/routes.ts", "Beta", "/project");
        assert.equal(conflict, null);
    });

    it("releases specific paths", () => {
        reservations.createReservation("Alpha", ["src/auth/", "src/api/"], "Working");
        const released = reservations.releaseReservation("Alpha", ["src/auth/"]);
        assert.equal(released.length, 1);

        // Should still have src/api/
        const remaining = reservations.getReservations("Alpha");
        assert.equal(remaining.length, 1);
        assert.deepEqual(remaining[0]!.paths, ["src/api/"]);
    });

    it("releases all when no paths specified", () => {
        reservations.createReservation("Alpha", ["src/auth/"], "Working");
        reservations.createReservation("Alpha", ["src/api/"], "Also working");
        const released = reservations.releaseReservation("Alpha");
        assert.equal(released.length, 2);
        assert.equal(reservations.getReservations("Alpha").length, 0);
    });

    it("getAllReservations returns all agents", () => {
        reservations.createReservation("Alpha", ["src/auth/"], "Auth");
        reservations.createReservation("Beta", ["src/api/"], "API");
        const all = reservations.getAllReservations();
        assert.equal(all.size, 2);
        assert.ok(all.has("Alpha"));
        assert.ok(all.has("Beta"));
    });

    it("clearReservations removes agent", () => {
        reservations.createReservation("Alpha", ["src/auth/"], "Auth");
        reservations.clearReservations("Alpha");
        assert.equal(reservations.getReservations("Alpha").length, 0);
    });
});
