/**
 * In-Memory Transport
 *
 * A pair of transports connected back-to-back for testing.
 * Write to one end, read from the other. Synchronous, no real I/O.
 *
 * **IMPORTANT: Synchronous delivery asymmetry.**
 * Unlike real Unix sockets (where data arrives asynchronously on a future event-loop tick),
 * InMemoryTransport delivers data *synchronously inside write()*. This means:
 *
 * 1. A write() call immediately invokes the peer's data handlers before returning.
 * 2. Tests using InMemoryTransport may pass even when production code has ordering bugs
 *    that depend on async delivery timing.
 * 3. SwarmClient.connectWithTransport() specifically handles this by registering the
 *    data handler BEFORE sending the registration message — with synchronous transports,
 *    the server's "registered" response arrives during the write() call.
 *
 * Tests mitigate this with `await delay(10)` to give the event loop a tick for any
 * async processing that wraps the synchronous transport.
 *
 * Usage:
 *   const [client, server] = createMemoryTransportPair();
 *   // data written to client arrives on server, and vice versa
 */

import type { Transport, TransportServer } from "./types.js";

export class InMemoryTransport implements Transport {
    private _connected: boolean = true;
    private _peer: InMemoryTransport | null = null;
    private dataHandlers: ((data: string) => void)[] = [];
    private closeHandlers: (() => void)[] = [];
    private errorHandlers: ((err: Error) => void)[] = [];

    get connected(): boolean {
        return this._connected;
    }

    /** Link this transport to its peer (internal use). */
    _setPeer(peer: InMemoryTransport): void {
        this._peer = peer;
    }

    write(data: string): void {
        if (!this._connected) return;
        if (!this._peer || !this._peer._connected) return;
        // Deliver to peer's data handlers
        for (const handler of this._peer.dataHandlers) {
            handler(data);
        }
    }

    onData(handler: (data: string) => void): void {
        this.dataHandlers.push(handler);
    }

    onClose(handler: () => void): void {
        this.closeHandlers.push(handler);
    }

    onError(handler: (err: Error) => void): void {
        this.errorHandlers.push(handler);
    }

    close(): void {
        if (!this._connected) return;
        this._connected = false;
        // Notify own close handlers
        for (const handler of this.closeHandlers) {
            handler();
        }
        // Also close the peer (like a real socket)
        if (this._peer && this._peer._connected) {
            this._peer.close();
        }
    }

    /** Inject an error (for testing error handling). */
    _injectError(err: Error): void {
        for (const handler of this.errorHandlers) {
            handler(err);
        }
    }
}

/**
 * Create a pair of connected in-memory transports.
 * Data written to [0] is delivered to [1]'s data handlers, and vice versa.
 */
export function createMemoryTransportPair(): [InMemoryTransport, InMemoryTransport] {
    const a = new InMemoryTransport();
    const b = new InMemoryTransport();
    a._setPeer(b);
    b._setPeer(a);
    return [a, b];
}

/**
 * In-memory transport server for testing.
 * When a client connects via connectToServer(), the server's connection
 * handler receives the server-side transport.
 */
export class InMemoryTransportServer implements TransportServer {
    private connectionHandler: ((transport: Transport) => void) | null = null;
    private _running: boolean = false;

    get running(): boolean {
        return this._running;
    }

    onConnection(handler: (transport: Transport) => void): void {
        this.connectionHandler = handler;
    }

    async start(): Promise<void> {
        this._running = true;
    }

    async stop(): Promise<void> {
        this._running = false;
    }

    /**
     * Simulate a client connecting. Returns the client-side transport.
     * The server-side transport is delivered to the connection handler.
     */
    connect(): InMemoryTransport {
        if (!this._running) {
            throw new Error("Server not running");
        }
        const [clientSide, serverSide] = createMemoryTransportPair();
        if (this.connectionHandler) {
            this.connectionHandler(serverSide);
        }
        return clientSide;
    }
}
