/**
 * Transport Layer Types
 *
 * Interfaces for the transport abstraction. The server/client use these
 * instead of net.Socket/net.Server directly. Currently implemented by
 * UnixTransport (production) and InMemoryTransport (tests).
 */

/** A bidirectional byte stream — the minimal abstraction over a connection. */
export interface Transport {
    /** Send data through the transport */
    write(data: string): void;
    /** Register a data handler */
    onData(handler: (data: string) => void): void;
    /** Register a close handler */
    onClose(handler: () => void): void;
    /** Register an error handler */
    onError(handler: (err: Error) => void): void;
    /** Close the transport */
    close(): void;
    /** Whether the transport is currently connected */
    readonly connected: boolean;
}

/** Server that accepts Transport connections. */
export interface TransportServer {
    /** Start listening for connections */
    start(): Promise<void>;
    /** Stop the server and close all connections */
    stop(): Promise<void>;
    /** Register a connection handler */
    onConnection(handler: (transport: Transport) => void): void;
}
