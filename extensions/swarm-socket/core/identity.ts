/**
 * Identity
 *
 * Single source of truth for "who am I" in the swarm.
 * Constructed once from environment variables at startup.
 * Simplified for channel-based architecture — no hierarchical codes.
 */

import { ENV } from "./channels.js";

export type Role = "queen" | "coordinator" | "agent";

export interface Identity {
    name: string;
    role: Role;
    swarm?: string;
}

// Module-level singleton
let _identity: Identity | null = null;

/**
 * Create the identity for this instance from environment variables.
 * Called once at startup. Subsequent calls return the cached identity.
 *
 * NOTE: The result is cached in a module-level singleton. If running multiple
 * tests in the same process that manipulate `process.env`, call `resetIdentity()`
 * between tests to clear the cache.
 */
export function createIdentity(): Identity {
    if (_identity) return _identity;

    _identity = {
        name: process.env[ENV.NAME] || process.env.PI_SWARM_AGENT_NAME || "queen",
        role: (process.env.PI_SWARM_AGENT_ROLE as Role) || "queen",
        swarm: process.env.PI_SWARM_AGENT_SWARM,
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
 * Get the channel group path from environment.
 * Returns undefined if not in a swarm (queen mode).
 */
export function getChannelGroupPath(): string | undefined {
    return process.env[ENV.GROUP] || undefined;
}

/**
 * Get the inbox channel name from environment.
 * Returns undefined if not in a swarm.
 */
export function getInboxChannel(): string | undefined {
    return process.env[ENV.INBOX] || undefined;
}

/**
 * Get the channels this agent should subscribe to (read from).
 * Returns array of channel names, defaults to ["general"].
 */
export function getSubscribeChannels(): string[] {
    const raw = process.env[ENV.SUBSCRIBE];
    if (!raw) return ["general"];
    return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Reset identity (for testing only).
 * MUST be called between tests if running in the same process,
 * since `createIdentity()` caches the result in a module singleton.
 */
export function resetIdentity(): void {
    _identity = null;
}
