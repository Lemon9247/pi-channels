/**
 * Router
 *
 * Message routing rules for the swarm. Determines which clients
 * can receive messages from which senders based on role and swarm.
 *
 * Extracted from server.ts to enable future routing strategies
 * (subject-based addressing in P2A).
 */

import type { Role, ClientMessage, BaseMessage } from "../transport/protocol.js";

/** Identity fields used for routing — no socket dependency */
export interface SenderInfo {
    name: string;
    role: Role;
    swarm?: string;
}

export interface Router {
    canReach(from: SenderInfo, to: SenderInfo): boolean;
    getRecipients<T extends SenderInfo>(
        from: SenderInfo,
        msg: ClientMessage,
        clients: Map<string, T>,
    ): T[];
}

/**
 * Default routing rules:
 * - Agent → own swarm siblings + own coordinator
 * - Coordinator → own agents + other coordinators + queen
 * - Queen → anyone
 */
export class DefaultRouter implements Router {
    canReach(from: SenderInfo, to: SenderInfo): boolean {
        switch (from.role) {
            case "queen":
                return true;

            case "coordinator":
                if (to.role === "queen") return true;
                if (to.role === "coordinator") return true;
                if (to.role === "agent" && to.swarm === from.swarm) return true;
                return false;

            case "agent":
                if (to.role === "agent" && to.swarm === from.swarm) return true;
                if (to.role === "coordinator" && to.swarm === from.swarm) return true;
                return false;

            default:
                return false;
        }
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
