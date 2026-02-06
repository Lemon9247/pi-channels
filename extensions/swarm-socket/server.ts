/**
 * Swarm Socket Server
 *
 * Unix socket server that handles agent registration, message routing,
 * and access control for swarm coordination.
 */

import * as net from "node:net";
import * as fs from "node:fs";
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
} from "./protocol.js";

/** Identity fields used for routing — no socket dependency */
export interface SenderInfo {
    name: string;
    role: Role;
    swarm?: string;
}

export interface ClientConnection extends SenderInfo {
    socket: net.Socket;
    buffer: string;
    registered: boolean;
}

export type ServerEventHandler = {
    onRegister?: (client: ClientConnection) => void;
    onMessage?: (from: ClientConnection, message: ClientMessage) => void;
    onDisconnect?: (client: ClientConnection) => void;
    onError?: (error: Error) => void;
};

export class SwarmServer {
    private server: net.Server;
    private clients: Map<string, ClientConnection> = new Map();
    private unregistered: Set<net.Socket> = new Set();
    private socketPath: string;
    private handlers: ServerEventHandler;

    constructor(socketPath: string, handlers: ServerEventHandler = {}) {
        this.socketPath = socketPath;
        this.handlers = handlers;
        this.server = net.createServer((socket) => this.handleConnection(socket));
    }

    async start(): Promise<void> {
        // Clean up stale socket file
        try {
            fs.unlinkSync(this.socketPath);
        } catch {
            // Doesn't exist, fine
        }

        return new Promise((resolve, reject) => {
            this.server.on("error", reject);
            this.server.listen(this.socketPath, () => {
                this.server.removeListener("error", reject);
                resolve();
            });
        });
    }

    async stop(): Promise<void> {
        // Close all client connections
        for (const client of this.clients.values()) {
            client.socket.destroy();
        }
        for (const socket of this.unregistered) {
            socket.destroy();
        }
        this.clients.clear();
        this.unregistered.clear();

        return new Promise((resolve) => {
            this.server.close(() => {
                // Clean up socket file
                try {
                    fs.unlinkSync(this.socketPath);
                } catch {
                    // Already gone
                }
                resolve();
            });
        });
    }

    getClients(): Map<string, ClientConnection> {
        return this.clients;
    }

    getClient(name: string): ClientConnection | undefined {
        return this.clients.get(name);
    }

    private handleConnection(socket: net.Socket): void {
        this.unregistered.add(socket);

        // Partial client state before registration
        const preClient: { buffer: string } = { buffer: "" };

        socket.on("data", (data) => {
            // Find the registered client for this socket, or use pre-registration state
            let client: ClientConnection | undefined;
            for (const c of this.clients.values()) {
                if (c.socket === socket) {
                    client = c;
                    break;
                }
            }

            const state = client || preClient;
            state.buffer += data.toString();
            const { messages, remainder } = parseLines(state.buffer);
            state.buffer = remainder;

            for (const raw of messages) {
                if (!client) {
                    // Must register first
                    if (!validateRegister(raw)) {
                        this.sendToSocket(socket, serialize({ type: "error", message: "First message must be a valid register message" }));
                        continue;
                    }
                    this.handleRegister(socket, raw as RegisterMessage, preClient);
                    // After registration, find the client
                    for (const c of this.clients.values()) {
                        if (c.socket === socket) {
                            client = c;
                            // Transfer any remaining buffer
                            client.buffer = state.buffer;
                            break;
                        }
                    }
                } else {
                    if (!validateClientMessage(raw)) {
                        this.sendToSocket(socket, serialize({ type: "error", message: "Invalid message format" }));
                        continue;
                    }
                    this.handleMessage(client, raw as ClientMessage);
                }
            }
        });

        socket.on("close", () => {
            this.unregistered.delete(socket);
            // Find and remove the registered client
            for (const [name, client] of this.clients.entries()) {
                if (client.socket === socket) {
                    this.clients.delete(name);
                    this.handlers.onDisconnect?.(client);
                    break;
                }
            }
        });

        socket.on("error", (err) => {
            this.handlers.onError?.(err);
        });
    }

    private handleRegister(socket: net.Socket, msg: RegisterMessage, preClient: { buffer: string }): void {
        // Check name uniqueness
        if (this.clients.has(msg.name)) {
            this.sendToSocket(socket, serialize({ type: "error", message: `Duplicate name: "${msg.name}"` }));
            return;
        }

        const client: ClientConnection = {
            socket,
            name: msg.name,
            role: msg.role,
            swarm: msg.swarm,
            buffer: preClient.buffer,
            registered: true,
        };

        this.clients.set(msg.name, client);
        this.unregistered.delete(socket);
        this.sendToSocket(socket, serialize({ type: "registered" }));
        this.handlers.onRegister?.(client);
    }

    private handleMessage(from: ClientConnection, msg: ClientMessage): void {
        if (msg.type === "register") {
            this.sendToSocket(from.socket, serialize({ type: "error", message: "Already registered" }));
            return;
        }

        this.handlers.onMessage?.(from, msg);

        const recipients = this.getRecipients(from, msg);
        if (recipients.length === 0 && msg.type === "instruct") {
            // Instruct with no valid recipients — notify sender
            const target = (msg as InstructMessage).to || (msg as InstructMessage).swarm || "all";
            this.sendToSocket(from.socket, serialize({
                type: "error",
                message: `No valid recipients for instruct to "${target}"`,
            }));
            return;
        }

        const relayed: RelayedMessage = {
            from: from.name,
            fromRole: from.role,
            fromSwarm: from.swarm,
            message: msg as RelayedMessage["message"],
        };

        const serialized = serialize(relayed);
        for (const recipient of recipients) {
            this.sendToSocket(recipient.socket, serialized);
        }
    }

    /**
     * Determine valid recipients for a message based on routing rules:
     *
     * - Agent → own swarm siblings + own coordinator
     * - Coordinator → own agents + other coordinators + queen
     * - Queen → anyone
     *
     * Instruct messages use `to` and `swarm` fields for targeting.
     * Other messages broadcast to all allowed recipients (excluding sender).
     */
    getRecipients(from: SenderInfo, msg: ClientMessage): ClientConnection[] {
        const recipients: ClientConnection[] = [];

        if (msg.type === "instruct") {
            const instruct = msg as InstructMessage;
            // Targeted delivery
            for (const client of this.clients.values()) {
                if (client.name === from.name) continue;
                if (!this.canReach(from, client)) continue;

                if (instruct.to) {
                    // Specific agent
                    if (client.name === instruct.to) {
                        recipients.push(client);
                    }
                } else if (instruct.swarm) {
                    // All in a swarm
                    if (client.swarm === instruct.swarm) {
                        recipients.push(client);
                    }
                } else {
                    // Broadcast to all reachable
                    recipients.push(client);
                }
            }
        } else {
            // Broadcast to all allowed recipients
            for (const client of this.clients.values()) {
                if (client.name === from.name) continue;
                if (this.canReach(from, client)) {
                    recipients.push(client);
                }
            }
        }

        return recipients;
    }

    /**
     * Check if `from` is allowed to send messages to `to`.
     */
    canReach(from: SenderInfo, to: SenderInfo): boolean {
        switch (from.role) {
            case "queen":
                // Queen can reach anyone
                return true;

            case "coordinator":
                // Coordinator can reach: own agents, other coordinators, queen
                if (to.role === "queen") return true;
                if (to.role === "coordinator") return true;
                if (to.role === "agent" && to.swarm === from.swarm) return true;
                return false;

            case "agent":
                // Agent can reach: own swarm siblings (agents), own coordinator
                if (to.role === "agent" && to.swarm === from.swarm) return true;
                if (to.role === "coordinator" && to.swarm === from.swarm) return true;
                return false;

            default:
                return false;
        }
    }

    private sendToSocket(socket: net.Socket, data: string): void {
        try {
            if (!socket.destroyed) {
                socket.write(data);
            }
        } catch {
            // Socket might have closed between check and write
        }
    }
}
