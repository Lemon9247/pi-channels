/**
 * Tests for cleanStaleSockets (T3).
 *
 * Verifies that:
 * - Stale socket files (not listening) are removed
 * - Live socket files (active server) are NOT removed
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { test, assert, delay, summarize, tmpSocketPath } from "../helpers.js";
import { cleanStaleSockets } from "../../transport/unix-socket.js";
import { SwarmServer } from "../../core/server.js";
import { UnixTransportServer } from "../../transport/unix-socket.js";

async function main() {
    console.log("\ncleanStaleSockets (T3):");

    await test("removes stale socket file (not listening)", async () => {
        // Create a socket file that's NOT listening — just a regular file
        // with the naming convention pi-swarm-*.sock
        const sockPath = path.join(os.tmpdir(), `pi-swarm-stale-test-${Date.now()}.sock`);
        fs.writeFileSync(sockPath, "");
        assert(fs.existsSync(sockPath), "stale socket file exists before cleanup");

        cleanStaleSockets();
        // cleanStaleSockets uses async probing (net.createConnection) with timeout
        // Wait for the probes to complete
        await delay(1000);

        assert(!fs.existsSync(sockPath), "stale socket file removed after cleanup");
    });

    await test("does NOT remove live socket file", async () => {
        const sockPath = tmpSocketPath();
        // Ensure the path starts with pi-swarm- so cleanStaleSockets finds it
        // tmpSocketPath already uses pi-swarm-test- prefix
        const server = new SwarmServer(new UnixTransportServer(sockPath));
        await server.start();

        assert(fs.existsSync(sockPath), "live socket file exists");

        cleanStaleSockets();
        await delay(1000);

        assert(fs.existsSync(sockPath), "live socket file still exists after cleanup");

        await server.stop();
    });

    await test("ignores non-matching socket files", async () => {
        // Create a file that doesn't match the pi-swarm-*.sock pattern
        const otherPath = path.join(os.tmpdir(), `other-service-${Date.now()}.sock`);
        fs.writeFileSync(otherPath, "");

        cleanStaleSockets();
        await delay(1000);

        assert(fs.existsSync(otherPath), "non-matching file NOT removed");
        fs.unlinkSync(otherPath); // cleanup
    });
}

main().then(() => summarize());
