/**
 * Swarm Socket Client
 *
 * Connects to the swarm socket server, registers as an agent/coordinator/queen,
 * and provides methods to send messages and receive relayed messages.
 *
 * Transport-agnostic — uses Transport interface instead of net.Socket directly.
 */

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
import type { Transport } from "../transport/types.js";
import { connectUnix } from "../transport/unix-socket.js";

export interface SwarmClientOptions {
    name: string;
    role: Role;
    swarm?: string;
}

export class SwarmClient extends EventEmitter {
    private transport: Transport | null = null;
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
     * Creates a UnixTransport from the socket path.
     */
    async connect(socketPath: string): Promise<void> {
        const transport = await connectUnix(socketPath);
        return this.connectWithTransport(transport);
    }

    /**
     * Connect using a pre-created Transport (e.g. InMemoryTransport for tests).
     * Sends registration and resolves when confirmed.
     */
    async connectWithTransport(transport: Transport): Promise<void> {
        this.transport = transport;
        this._connected = true;

        return new Promise((resolve, reject) => {
            let registrationDone = false;

            // Register data handler BEFORE sending — with synchronous transports
            // (InMemoryTransport), the response arrives during the write() call.
            const onData = (data: string) => {
                this.buffer += data;
                const { messages, remainder } = parseLines(this.buffer);
                this.buffer = remainder;

                for (const raw of messages) {
                    const msg = raw as ServerMessage;

                    if ((msg as RegisteredMessage).type === "registered") {
                        this._registered = true;
                        // Switch to normal message handling
                        this.transport!.onData((d) => this.handleData(d));
                        registrationDone = true;
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

            transport.onData((data) => {
                if (!registrationDone) {
                    onData(data);
                }
            });

            transport.onError((err) => {
                if (!this._registered) {
                    reject(err);
                } else {
                    this.emit("error", err.message);
                }
            });

            transport.onClose(() => {
                this._connected = false;
                this._registered = false;
                this.emit("disconnect");
            });

            // Send registration AFTER handlers are set up
            this.send({
                type: "register",
                name: this.options.name,
                role: this.options.role,
                swarm: this.options.swarm,
            });
        });
    }

    /**
     * Send a message through the transport.
     */
    send(msg: ClientMessage): void {
        if (!this.transport || !this.transport.connected) {
            throw new Error("Not connected");
        }
        this.transport.write(serialize(msg));
    }

    /**
     * Send a nudge to notify swarm of hive-mind update.
     */
    nudge(reason: string, options?: { to?: string; swarm?: string; payload?: import("../transport/protocol.js").NudgePayload }): void {
        this.send({ type: "nudge", reason, ...options });
    }

    /**
     * Signal a blocker.
     */
    blocker(description: string, options?: { to?: string; swarm?: string }): void {
        this.send({ type: "blocker", description, ...options });
    }

    /**
     * Signal task completion.
     */
    done(summary: string, options?: { to?: string; swarm?: string }): void {
        this.send({ type: "done", summary, ...options });
    }

    /**
     * Send a relay message (first-class sub-agent event).
     */
    relay(relay: import("../transport/protocol.js").RelayEvent): void {
        this.send({ type: "relay", relay });
    }

    /**
     * Send a progress update.
     */
    progress(options: { phase?: string; percent?: number; detail?: string }): void {
        this.send({ type: "progress", ...options });
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
        if (this.transport) {
            this.transport.close();
            this.transport = null;
            this._connected = false;
            this._registered = false;
        }
    }

    private handleData(data: string): void {
        this.buffer += data;
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
