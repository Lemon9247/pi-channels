import * as path from "node:path";
import * as registry from "./registry.js";
import { type Reservation } from "./types.js";

export function checkConflict(
    filePath: string,
    myName: string,
    projectDir: string,
): { reservation: Reservation; agent: string } | null {
    const resolved = path.resolve(projectDir, filePath);

    for (const agent of registry.listAgentsForProject(projectDir)) {
        if (agent.name === myName) continue;

        for (const reservation of agent.reservations) {
            for (const reservedPath of reservation.paths) {
                const resolvedReserved = path.resolve(projectDir, reservedPath);
                if (
                    resolved === resolvedReserved
                    || resolved.startsWith(resolvedReserved + "/")
                    || resolvedReserved.startsWith(resolved + "/")
                ) {
                    return { reservation, agent: agent.name };
                }
            }
        }
    }

    return null;
}

export function createReservation(agent: string, paths: string[], reason: string): Reservation {
    return {
        paths,
        reason,
        agent,
        timestamp: new Date().toISOString(),
    };
}

export function addReservation(
    existing: Reservation[],
    agent: string,
    paths: string[],
    reason: string,
): Reservation[] {
    return [...existing, createReservation(agent, paths, reason)];
}

export function releaseReservations(
    existing: Reservation[],
    paths?: string[],
): { kept: Reservation[]; released: Reservation[] } {
    if (!paths) {
        return { kept: [], released: existing };
    }

    const pathSet = new Set(paths);
    const kept: Reservation[] = [];
    const released: Reservation[] = [];

    for (const reservation of existing) {
        const remaining = reservation.paths.filter((value) => !pathSet.has(value));
        if (remaining.length === 0) {
            released.push(reservation);
        } else if (remaining.length < reservation.paths.length) {
            released.push({ ...reservation, paths: reservation.paths.filter((value) => pathSet.has(value)) });
            kept.push({ ...reservation, paths: remaining });
        } else {
            kept.push(reservation);
        }
    }

    return { kept, released };
}
