/**
 * Swarm Socket Server
 *
 * Accepts connections via a TransportServer, handles agent registration,
 * message routing, and access control for swarm coordination.
 *
 * Transport-agnostic — works with UnixTransportServer (production)
 * or InMemoryTransportServer (tests).
 */

import {
    type Role,
    type ClientMessage,
    type RelayedMessage,
    type RegisterMessage,
    type InstructMessage,
    serialize,
    parseLines,
    validateRegister,
    validateClientMessage,
} from "../transport/protocol.js";
import type { Transport, TransportServer } from "../transport/types.js";
import {
    type SenderInfo,
    type Subject,
    type Router,
    type SubscriptionPolicy,
    DefaultRouter,
    DefaultPolicy,
    computeSubjects,
} from "./router.js";

export { type SenderInfo } from "./router.js";

export interface ClientConnection extends SenderInfo {
    transport: Transport;
    buffer: string;
    registered: boolean;
    /** Subjects this client subscribes to (computed on registration) */
    subscriptions: Subject[];
    /** Subjects this client can publish to (computed on registration) */
    publications: Subject[];
}

export type ServerEventHandler = {
    onRegister?: (client: ClientConnection) => void;
    onMessage?: (from: ClientConnection, message: ClientMessage) => void;
    onDisconnect?: (client: ClientConnection) => void;
    onError?: (error: Error) => void;
};

export class SwarmServer {
    private transportServer: TransportServer;
    private clients: Map<string, ClientConnection> = new Map();
    private unregistered: Set<Transport> = new Set();
    private handlers: ServerEventHandler;
    private router: Router;
    private policy: SubscriptionPolicy;

    constructor(transportServer: TransportServer, handlers: ServerEventHandler = {}, router?: Router, policy?: SubscriptionPolicy) {
        this.transportServer = transportServer;
        this.handlers = handlers;
        this.policy = policy || new DefaultPolicy();
        this.router = router || new DefaultRouter(this.policy);
        this.transportServer.onConnection((transport) => this.handleConnection(transport));
    }

    async start(): Promise<void> {
        await this.transportServer.start();
    }

    async stop(): Promise<void> {
        // Close all client connections
        for (const client of this.clients.values()) {
            client.transport.close();
        }
        for (const transport of this.unregistered) {
            transport.close();
        }
        this.clients.clear();
        this.unregistered.clear();

        await this.transportServer.stop();
    }

    getClients(): Map<string, ClientConnection> {
        return this.clients;
    }

    getClient(name: string): ClientConnection | undefined {
        return this.clients.get(name);
    }

    /**
     * Get valid recipients for a message using the router.
     * Convenience method that passes the current client map.
     */
    getRecipients(from: SenderInfo, msg: ClientMessage): ClientConnection[] {
        return this.router.getRecipients(from, msg, this.clients);
    }

    /**
     * Check if `from` is allowed to send messages to `to`.
     * Delegates to the router.
     */
    canReach(from: SenderInfo, to: SenderInfo): boolean {
        return this.router.canReach(from, to);
    }

    private handleConnection(transport: Transport): void {
        this.unregistered.add(transport);

        // Partial client state before registration
        const preClient: { buffer: string } = { buffer: "" };

        transport.onData((data) => {
            // Find the registered client for this transport
            let client: ClientConnection | undefined;
            for (const c of this.clients.values()) {
                if (c.transport === transport) {
                    client = c;
                    break;
                }
            }

            const state = client || preClient;
            state.buffer += data;
            const { messages, remainder } = parseLines(state.buffer);
            state.buffer = remainder;

            for (const raw of messages) {
                if (!client) {
                    // Must register first
                    if (!validateRegister(raw)) {
                        this.sendTo(transport, serialize({ type: "error", message: "First message must be a valid register message" }));
                        continue;
                    }
                    this.handleRegister(transport, raw as RegisterMessage, preClient);
                    // After registration, find the client
                    for (const c of this.clients.values()) {
                        if (c.transport === transport) {
                            client = c;
                            // Transfer any remaining buffer
                            client.buffer = state.buffer;
                            break;
                        }
                    }
                } else {
                    if (!validateClientMessage(raw)) {
                        this.sendTo(transport, serialize({ type: "error", message: "Invalid message format" }));
                        continue;
                    }
                    this.handleMessage(client, raw as ClientMessage);
                }
            }
        });

        transport.onClose(() => {
            this.unregistered.delete(transport);
            // Find and remove the registered client
            for (const [name, client] of this.clients.entries()) {
                if (client.transport === transport) {
                    this.clients.delete(name);
                    this.handlers.onDisconnect?.(client);
                    break;
                }
            }
        });

        transport.onError((err) => {
            this.handlers.onError?.(err);
        });
    }

    private handleRegister(transport: Transport, msg: RegisterMessage, preClient: { buffer: string }): void {
        // Check name uniqueness
        if (this.clients.has(msg.name)) {
            this.sendTo(transport, serialize({ type: "error", message: `Duplicate name: "${msg.name}"` }));
            return;
        }

        // Compute subscriptions and publications from the policy
        const { subscriptions, publications } = computeSubjects(
            { name: msg.name, role: msg.role, swarm: msg.swarm },
            this.policy,
        );

        const client: ClientConnection = {
            transport,
            name: msg.name,
            role: msg.role,
            swarm: msg.swarm,
            buffer: preClient.buffer,
            registered: true,
            subscriptions,
            publications,
        };

        this.clients.set(msg.name, client);
        this.unregistered.delete(transport);
        this.sendTo(transport, serialize({ type: "registered" }));
        this.handlers.onRegister?.(client);
    }

    private handleMessage(from: ClientConnection, msg: ClientMessage): void {
        if (msg.type === "register") {
            this.sendTo(from.transport, serialize({ type: "error", message: "Already registered" }));
            return;
        }

        this.handlers.onMessage?.(from, msg);

        const recipients = this.getRecipients(from, msg);
        if (recipients.length === 0 && msg.type === "instruct") {
            // Instruct with no valid recipients — notify sender
            const target = (msg as InstructMessage).to || (msg as InstructMessage).swarm || "all";
            this.sendTo(from.transport, serialize({
                type: "error",
                message: `No valid recipients for instruct to "${target}"`,
            }));
            return;
        }

        const relayed: RelayedMessage = {
            from: { name: from.name, role: from.role, swarm: from.swarm },
            message: msg as RelayedMessage["message"],
        };

        const serialized = serialize(relayed);
        for (const recipient of recipients) {
            this.sendTo(recipient.transport, serialized);
        }
    }

    private sendTo(transport: Transport, data: string): void {
        try {
            if (transport.connected) {
                transport.write(data);
            }
        } catch {
            // Transport might have closed between check and write
        }
    }
}
