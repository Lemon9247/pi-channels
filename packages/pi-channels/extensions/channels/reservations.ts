import * as path from "node:path";
import { type Reservation } from "./types.js";

/**
 * In-memory reservation cache. Updated from mesh events.
 * Key: agent name, Value: their reservations.
 */
const reservationCache: Map<string, Reservation[]> = new Map();

/**
 * Add/update reservations for an agent.
 */
export function setReservations(agent: string, reservations: Reservation[]): void {
    if (reservations.length === 0) {
        reservationCache.delete(agent);
    } else {
        reservationCache.set(agent, reservations);
    }
}

/**
 * Get all reservations for an agent.
 */
export function getReservations(agent: string): Reservation[] {
    return reservationCache.get(agent) ?? [];
}

/**
 * Get all reservations across all agents.
 */
export function getAllReservations(): Map<string, Reservation[]> {
    return new Map(reservationCache);
}

/**
 * Clear all reservations for an agent.
 */
export function clearReservations(agent: string): void {
    reservationCache.delete(agent);
}

/**
 * Clear the entire cache (used on shutdown).
 */
export function clearAllReservations(): void {
    reservationCache.clear();
}

/**
 * Check if a file path conflicts with any existing reservation from another agent.
 * Returns the conflicting reservation if found, null otherwise.
 */
export function checkConflict(
    filePath: string,
    myName: string,
    projectDir: string,
): { reservation: Reservation; agent: string } | null {
    // Resolve the file path relative to project dir
    const resolved = path.resolve(projectDir, filePath);

    for (const [agent, reservations] of reservationCache) {
        if (agent === myName) continue;

        for (const reservation of reservations) {
            for (const reservedPath of reservation.paths) {
                const resolvedReserved = path.resolve(projectDir, reservedPath);

                // Check if the file is inside the reserved path (directory reservation)
                // or if they're the same file
                if (
                    resolved === resolvedReserved ||
                    resolved.startsWith(resolvedReserved + "/") ||
                    resolvedReserved.startsWith(resolved + "/")
                ) {
                    return { reservation, agent };
                }
            }
        }
    }

    return null;
}

/**
 * Create a reservation.
 */
export function createReservation(
    agent: string,
    paths: string[],
    reason: string,
): Reservation {
    const reservation: Reservation = {
        paths,
        reason,
        agent,
        timestamp: new Date().toISOString(),
    };

    const existing = getReservations(agent);
    setReservations(agent, [...existing, reservation]);
    return reservation;
}

/**
 * Release specific paths for an agent.
 */
export function releaseReservation(agent: string, paths?: string[]): Reservation[] {
    if (!paths) {
        // Release all
        const released = getReservations(agent);
        clearReservations(agent);
        return released;
    }

    const existing = getReservations(agent);
    const pathSet = new Set(paths);
    const kept: Reservation[] = [];
    const released: Reservation[] = [];

    for (const r of existing) {
        const remaining = r.paths.filter((p) => !pathSet.has(p));
        if (remaining.length === 0) {
            released.push(r);
        } else if (remaining.length < r.paths.length) {
            released.push({ ...r, paths: r.paths.filter((p) => pathSet.has(p)) });
            kept.push({ ...r, paths: remaining });
        } else {
            kept.push(r);
        }
    }

    setReservations(agent, kept);
    return released;
}
