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
    type BaseMessage,
    serialize,
    parseLines,
    validateRegister,
    validateClientMessage,
} from "../transport/protocol.js";
import { type SenderInfo, type Router, DefaultRouter } from "./router.js";

export { type SenderInfo } from "./router.js";

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
    private router: Router;

    constructor(socketPath: string, handlers: ServerEventHandler = {}, router?: Router) {
        this.socketPath = socketPath;
        this.handlers = handlers;
        this.router = router || new DefaultRouter();
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
        const baseMsg = msg as BaseMessage;
        if (recipients.length === 0 && (baseMsg.to || baseMsg.swarm)) {
            // Targeted message with no valid recipients — notify sender
            const target = baseMsg.to || baseMsg.swarm || "all";
            this.sendToSocket(from.socket, serialize({
                type: "error",
                message: `No valid recipients for ${msg.type} to "${target}"`,
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
