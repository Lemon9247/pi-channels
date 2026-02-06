/**
 * Identity
 *
 * Single source of truth for "who am I" in the swarm hierarchy.
 * Constructed once from environment variables at startup.
 * Also provides hierarchy helpers for working with positional codes.
 */

import type { Role } from "../transport/protocol.js";

export interface Identity {
    name: string;
    role: Role;
    swarm?: string;
    code: string;
}

// Module-level singleton
let _identity: Identity | null = null;

/**
 * Create the identity for this instance from environment variables.
 * Called once at startup. Subsequent calls return the cached identity.
 */
export function createIdentity(): Identity {
    if (_identity) return _identity;

    _identity = {
        name: process.env.PI_SWARM_AGENT_NAME || "queen",
        role: (process.env.PI_SWARM_AGENT_ROLE as Role) || "queen",
        swarm: process.env.PI_SWARM_AGENT_SWARM,
        code: process.env.PI_SWARM_CODE || "0",
    };
    return _identity;
}

/**
 * Get the current identity. Creates it if not yet initialized.
 */
export function getIdentity(): Identity {
    if (!_identity) return createIdentity();
    return _identity;
}

/**
 * Reset identity (for testing only).
 */
export function resetIdentity(): void {
    _identity = null;
}

// === Hierarchy Helpers ===

/** Derive level from code: "0.1.2" → 2 (count the dots) */
export function codeLevel(code: string): number {
    return code.split(".").length - 1;
}

/** Derive parent code: "0.1.2" → "0.1", "0.1" → "0" */
export function parentCode(code: string): string {
    const parts = code.split(".");
    return parts.slice(0, -1).join(".");
}

/** Check if code is a descendant of another: "0.1.2" is under "0.1" */
export function isDescendantOf(code: string, ancestor: string): boolean {
    return code.startsWith(ancestor + ".");
}

/**
 * Build a children lookup from a list of items with codes, grouped by parent code.
 * Returns a map of parentCode → sorted children.
 */
export function buildChildrenMap<T extends { code: string }>(
    agents: T[],
): { sorted: T[]; children: Map<string, T[]> } {
    const sorted = agents.slice().sort((a, b) =>
        a.code.localeCompare(b.code, undefined, { numeric: true }),
    );
    const children = new Map<string, T[]>();
    for (const agent of sorted) {
        const pc = parentCode(agent.code);
        if (!children.has(pc)) children.set(pc, []);
        children.get(pc)!.push(agent);
    }
    return { sorted, children };
}
