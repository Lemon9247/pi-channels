/**
 * Swarm Socket Client
 *
 * Connects to the swarm socket server, registers as an agent/coordinator/queen,
 * and provides methods to send messages and receive relayed messages.
 */

import * as net from "node:net";
import { EventEmitter } from "node:events";
import {
    type Role,
    type ClientMessage,
    type RelayedMessage,
    type ErrorMessage,
    type RegisteredMessage,
    type ServerMessage,
    serialize,
    parseLines,
    isRelayedMessage,
} from "../transport/protocol.js";

export interface SwarmClientOptions {
    name: string;
    role: Role;
    swarm?: string;
}

export class SwarmClient extends EventEmitter {
    private socket: net.Socket | null = null;
    private buffer: string = "";
    private options: SwarmClientOptions;
    private _connected: boolean = false;
    private _registered: boolean = false;

    constructor(options: SwarmClientOptions) {
        super();
        this.options = options;
    }

    get connected(): boolean {
        return this._connected;
    }

    get registered(): boolean {
        return this._registered;
    }

    get name(): string {
        return this.options.name;
    }

    get role(): Role {
        return this.options.role;
    }

    get swarm(): string | undefined {
        return this.options.swarm;
    }

    /**
     * Connect to the socket and register. Resolves when registration is confirmed.
     */
    async connect(socketPath: string): Promise<void> {
        return new Promise((resolve, reject) => {
            this.socket = net.createConnection(socketPath, () => {
                this._connected = true;

                // Send registration
                this.send({
                    type: "register",
                    name: this.options.name,
                    role: this.options.role,
                    swarm: this.options.swarm,
                });
            });

            // Wait for registered confirmation or error
            const onData = (data: Buffer) => {
                this.buffer += data.toString();
                const { messages, remainder } = parseLines(this.buffer);
                this.buffer = remainder;

                for (const raw of messages) {
                    const msg = raw as ServerMessage;

                    if ((msg as RegisteredMessage).type === "registered") {
                        this._registered = true;
                        // Switch to normal message handling
                        this.socket!.removeListener("data", onData);
                        this.socket!.on("data", (d) => this.handleData(d));
                        resolve();
                        return;
                    }

                    if ((msg as ErrorMessage).type === "error") {
                        const err = new Error((msg as ErrorMessage).message);
                        reject(err);
                        return;
                    }
                }
            };

            this.socket.on("data", onData);

            this.socket.on("error", (err) => {
                if (!this._registered) {
                    reject(err);
                } else {
                    this.emit("error", err.message);
                }
            });

            this.socket.on("close", () => {
                this._connected = false;
                this._registered = false;
                this.emit("disconnect");
            });
        });
    }

    /**
     * Send a message through the socket.
     */
    send(msg: ClientMessage): void {
        if (!this.socket || this.socket.destroyed) {
            throw new Error("Not connected");
        }
        this.socket.write(serialize(msg));
    }

    /**
     * Send a nudge to notify swarm of hive-mind update.
     */
    nudge(reason: string): void {
        this.send({ type: "nudge", reason });
    }

    /**
     * Signal a blocker.
     */
    blocker(description: string): void {
        this.send({ type: "blocker", description });
    }

    /**
     * Signal task completion.
     */
    done(summary: string): void {
        this.send({ type: "done", summary });
    }

    /**
     * Send an instruction to a specific agent, swarm, or all.
     */
    instruct(instruction: string, to?: string, swarm?: string): void {
        this.send({ type: "instruct", instruction, to, swarm });
    }

    /**
     * Disconnect from the server.
     */
    disconnect(): void {
        if (this.socket) {
            this.socket.destroy();
            this.socket = null;
            this._connected = false;
            this._registered = false;
        }
    }

    private handleData(data: Buffer): void {
        this.buffer += data.toString();
        const { messages, remainder } = parseLines(this.buffer);
        this.buffer = remainder;

        for (const raw of messages) {
            if (isRelayedMessage(raw)) {
                this.emit("message", raw as RelayedMessage);
            } else {
                const msg = raw as ServerMessage;
                if ((msg as ErrorMessage).type === "error") {
                    this.emit("error", (msg as ErrorMessage).message);
                }
            }
        }
    }
}

// Type-safe event interface
export interface SwarmClient {
    on(event: "message", listener: (msg: RelayedMessage) => void): this;
    on(event: "error", listener: (message: string) => void): this;
    on(event: "disconnect", listener: () => void): this;
    emit(event: "message", msg: RelayedMessage): boolean;
    emit(event: "error", message: string): boolean;
    emit(event: "disconnect"): boolean;
}
