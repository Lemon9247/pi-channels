/**
 * Router
 *
 * Subject-based message routing for the swarm. Each agent subscribes to
 * subjects (agent.name, swarm.name, role.type, all). Messages are routed
 * by matching sender's publication permissions against recipient's subscriptions.
 *
 * The subject model replaces the hardcoded canReach switch statement with
 * composable policies. DefaultPolicy reproduces the original routing exactly.
 */

import type { Role, ClientMessage, BaseMessage } from "../transport/protocol.js";

// === Subject Types ===

/** A subject is a string like "agent.a1", "swarm.alpha", "role.coordinator", "all" */
export type Subject = string;

/**
 * Subscription policy determines which subjects an identity can subscribe to
 * and publish to. Different policies produce different routing topologies.
 */
export interface SubscriptionPolicy {
    /** Which subjects this identity is allowed to subscribe to (receive messages on) */
    allowedSubscriptions(identity: SenderInfo): Subject[];
    /** Which subjects this identity is allowed to publish to (send messages on) */
    allowedPublications(identity: SenderInfo): Subject[];
}

// === Sender Info ===

/** Identity fields used for routing — no socket dependency */
export interface SenderInfo {
    name: string;
    role: Role;
    swarm?: string;
}

// === Subject Matching ===

/**
 * Check if a sender can reach a target based on subject intersection.
 * Sender's publications must overlap with target's subscriptions.
 * The wildcard subject "*" matches everything.
 */
export function subjectsOverlap(senderPubs: Subject[], targetSubs: Subject[]): boolean {
    if (senderPubs.includes("*") || targetSubs.includes("*")) return true;
    return senderPubs.some(p => targetSubs.includes(p));
}

/**
 * Compute subjects for an identity using a policy. Returns both subscriptions
 * and publications. Used on registration to precompute routing sets.
 */
export function computeSubjects(
    identity: SenderInfo,
    policy: SubscriptionPolicy,
): { subscriptions: Subject[]; publications: Subject[] } {
    return {
        subscriptions: policy.allowedSubscriptions(identity),
        publications: policy.allowedPublications(identity),
    };
}

// === Default Policy ===

/**
 * DefaultPolicy reproduces the original canReach routing exactly:
 * - Agent → own swarm siblings + own coordinator
 * - Coordinator → own agents + other coordinators + queen
 * - Queen → anyone
 *
 * Implementation:
 * - Agents publish to their own swarm subject. They subscribe to their name,
 *   swarm, role, and "all".
 * - Coordinators publish to their swarm, role.coordinator, and role.queen.
 *   They subscribe to their name, swarm, role.coordinator, and "all".
 * - Queen publishes to "*" (wildcard = everything). She subscribes to her
 *   name, role.queen, and "all" — NOT to agent swarm subjects, so agents
 *   cannot reach her (matching the original canReach rules).
 */
export class DefaultPolicy implements SubscriptionPolicy {
    allowedSubscriptions(identity: SenderInfo): Subject[] {
        switch (identity.role) {
            case "agent":
                return [
                    `agent.${identity.name}`,
                    `swarm.${identity.swarm}`,
                    "role.agent",
                    "all",
                ];
            case "coordinator":
                return [
                    `agent.${identity.name}`,
                    `swarm.${identity.swarm}`,
                    "role.coordinator",
                    "all",
                ];
            case "queen":
                return [
                    `agent.${identity.name}`,
                    "role.queen",
                    "all",
                ];
            default:
                return [];
        }
    }

    allowedPublications(identity: SenderInfo): Subject[] {
        switch (identity.role) {
            case "agent":
                return [`swarm.${identity.swarm}`];
            case "coordinator":
                return [
                    `swarm.${identity.swarm}`,
                    "role.coordinator",
                    "role.queen",
                ];
            case "queen":
                return ["*"];
            default:
                return [];
        }
    }
}

// === Router Interface ===

export interface Router {
    canReach(from: SenderInfo, to: SenderInfo): boolean;
    getRecipients<T extends SenderInfo>(
        from: SenderInfo,
        msg: ClientMessage,
        clients: Map<string, T>,
    ): T[];
}

/**
 * Default router using subject-based addressing.
 * Uses a SubscriptionPolicy to compute routing permissions.
 * With DefaultPolicy, produces identical results to the original canReach.
 */
export class DefaultRouter implements Router {
    private policy: SubscriptionPolicy;

    constructor(policy?: SubscriptionPolicy) {
        this.policy = policy || new DefaultPolicy();
    }

    /**
     * Check if sender can reach target by computing subject overlap.
     * Sender's publications must intersect with target's subscriptions.
     */
    canReach(from: SenderInfo, to: SenderInfo): boolean {
        const pubs = this.policy.allowedPublications(from);
        const subs = this.policy.allowedSubscriptions(to);
        return subjectsOverlap(pubs, subs);
    }

    getRecipients<T extends SenderInfo>(
        from: SenderInfo,
        msg: ClientMessage,
        clients: Map<string, T>,
    ): T[] {
        const recipients: T[] = [];

        // All message types support targeting via to/swarm fields
        const baseMsg = msg as BaseMessage;
        const hasTarget = baseMsg.to || baseMsg.swarm;

        if (hasTarget) {
            for (const client of clients.values()) {
                if (client.name === from.name) continue;
                if (!this.canReach(from, client)) continue;

                if (baseMsg.to) {
                    if (client.name === baseMsg.to) {
                        recipients.push(client);
                    }
                } else if (baseMsg.swarm) {
                    if (client.swarm === baseMsg.swarm) {
                        recipients.push(client);
                    }
                }
            }
        } else {
            for (const client of clients.values()) {
                if (client.name === from.name) continue;
                if (this.canReach(from, client)) {
                    recipients.push(client);
                }
            }
        }

        return recipients;
    }
}

// === Address Resolution ===

/**
 * AddressResolver resolves a subject to connections that should receive
 * a message. For local routing, this checks the local subscription table.
 * For inter-queen routing (P3), PeerResolver extends this to forward
 * to peer queens when no local subscriber matches.
 */
export interface AddressResolver {
    /** Resolve a subject to client names that should receive the message */
    resolve(
        subject: Subject,
        localSubscriptions: Map<string, Subject[]>,
    ): string[];
}

/**
 * LocalResolver: checks only local subscriptions. This is all that's
 * needed for single-queen swarms.
 */
export class LocalResolver implements AddressResolver {
    resolve(subject: Subject, localSubscriptions: Map<string, Subject[]>): string[] {
        const results: string[] = [];
        for (const [name, subs] of localSubscriptions) {
            if (subs.includes(subject) || subs.includes("*")) {
                results.push(name);
            }
        }
        return results;
    }
}

/**
 * PeerResolver: stub for P3 inter-queen routing.
 * Falls back to local resolution. Will be extended in P3 to check
 * peer queen routing tables when local resolution fails.
 */
export class PeerResolver implements AddressResolver {
    private local: LocalResolver = new LocalResolver();

    resolve(subject: Subject, localSubscriptions: Map<string, Subject[]>): string[] {
        // For now, just delegate to local resolution.
        // P3 will extend this to check peer queen routing tables
        // when local resolution returns no results.
        return this.local.resolve(subject, localSubscriptions);
    }
}

// === Peer Queen Policy ===

/**
 * PeerQueenPolicy: subscription policy that extends DefaultPolicy
 * for queen-to-queen communication. Allows queens to subscribe to
 * and publish on peer queen subjects.
 *
 * Not wired up yet — proves the policy abstraction works.
 * Will be used in P3 when inter-queen connections are established.
 */
export class PeerQueenPolicy implements SubscriptionPolicy {
    private base: DefaultPolicy = new DefaultPolicy();
    private peerQueenNames: string[];

    constructor(peerQueenNames: string[] = []) {
        this.peerQueenNames = peerQueenNames;
    }

    allowedSubscriptions(identity: SenderInfo): Subject[] {
        const base = this.base.allowedSubscriptions(identity);
        if (identity.role === "queen") {
            // Queens can also subscribe to peer queen name subjects
            return [
                ...base,
                ...this.peerQueenNames.map(name => `agent.${name}`),
            ];
        }
        return base;
    }

    allowedPublications(identity: SenderInfo): Subject[] {
        const base = this.base.allowedPublications(identity);
        if (identity.role === "queen") {
            // Queens can already publish to "*" via DefaultPolicy,
            // so no additional publications needed.
            return base;
        }
        return base;
    }
}
