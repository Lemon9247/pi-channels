/**
 * Transport Layer Types
 *
 * Interfaces for the transport abstraction. Currently only Unix sockets
 * are implemented, but this interface allows for future transports
 * (mock, tunneled, etc.)
 *
 * NOTE: Design-only for P1. Server/client don't use these interfaces
 * yet — that's P2B.
 */

export interface Transport {
    /** Send data through the transport */
    write(data: string): void;
    /** Whether the transport is currently connected */
    readonly connected: boolean;
    /** Close the transport */
    destroy(): void;
    /** Register event handlers */
    on(event: "data", handler: (data: Buffer) => void): this;
    on(event: "close", handler: () => void): this;
    on(event: "error", handler: (err: Error) => void): this;
}

export interface TransportServer {
    /** Start listening for connections */
    start(): Promise<void>;
    /** Stop the server and close all connections */
    stop(): Promise<void>;
    /** Register a connection handler */
    onConnection(handler: (transport: Transport) => void): void;
}
