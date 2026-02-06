/**
 * Unix Socket Transport
 *
 * Wraps net.Socket and net.Server as Transport and TransportServer.
 * This is the only production transport — others (InMemoryTransport)
 * are for testing.
 */

import * as net from "node:net";
import * as fs from "node:fs";
import type { Transport, TransportServer } from "./types.js";

/** Wraps a net.Socket as a Transport. */
export class UnixTransport implements Transport {
    private socket: net.Socket;

    constructor(socket: net.Socket) {
        this.socket = socket;
    }

    get connected(): boolean {
        return !this.socket.destroyed;
    }

    write(data: string): void {
        if (!this.socket.destroyed) {
            this.socket.write(data);
        }
    }

    onData(handler: (data: string) => void): void {
        this.socket.on("data", (buf: Buffer) => handler(buf.toString()));
    }

    onClose(handler: () => void): void {
        this.socket.on("close", handler);
    }

    onError(handler: (err: Error) => void): void {
        this.socket.on("error", handler);
    }

    close(): void {
        this.socket.destroy();
    }
}

/** Wraps a net.Server listening on a Unix socket as a TransportServer. */
export class UnixTransportServer implements TransportServer {
    private server: net.Server;
    private socketPath: string;
    private connectionHandler: ((transport: Transport) => void) | null = null;

    constructor(socketPath: string) {
        this.socketPath = socketPath;
        this.server = net.createServer((socket) => {
            if (this.connectionHandler) {
                this.connectionHandler(new UnixTransport(socket));
            }
        });
    }

    onConnection(handler: (transport: Transport) => void): void {
        this.connectionHandler = handler;
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
}

/**
 * Create a UnixTransport by connecting to a Unix socket path.
 * Resolves when the connection is established.
 */
export function connectUnix(socketPath: string): Promise<UnixTransport> {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection(socketPath, () => {
            resolve(new UnixTransport(socket));
        });
        socket.on("error", (err) => {
            reject(err);
        });
    });
}
