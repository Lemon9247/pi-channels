/**
 * Cross-coordinator instruct tests
 */

import { test, assert, assertEqual, tmpSocketPath, delay, summarize } from "../helpers.js";
import { SwarmServer } from "../../core/server.js";
import { SwarmClient } from "../../core/client.js";
import { UnixTransportServer } from "../../transport/unix-socket.js";

async function main() {
    console.log("\nCross-Coordinator Instruct:");

    await test("coordinator instruct reaches peer coordinator via parent socket", async () => {
        const queenSock = tmpSocketPath();
        const queenServer = new SwarmServer(new UnixTransportServer(queenSock));
        await queenServer.start();

        const coordA = new SwarmClient({ name: "coord-a", role: "coordinator", swarm: "alpha" });
        const coordB = new SwarmClient({ name: "coord-b", role: "coordinator", swarm: "beta" });
        await coordA.connect(queenSock);
        await coordB.connect(queenSock);

        const receivedB: any[] = [];
        coordB.on("message", (msg) => receivedB.push(msg));

        coordA.instruct("check your agents for auth bugs", "coord-b");
        await delay(50);

        assertEqual(receivedB.length, 1, "coord-b received instruct");
        assertEqual(receivedB[0].message.instruction, "check your agents for auth bugs", "instruction content");
        assertEqual(receivedB[0].from, "coord-a", "from coord-a");

        coordA.disconnect();
        coordB.disconnect();
        await queenServer.stop();
    });

    await test("coordinator instruct broadcast reaches peers and queen via parent socket", async () => {
        const queenSock = tmpSocketPath();
        const queenServer = new SwarmServer(new UnixTransportServer(queenSock));
        await queenServer.start();

        const queen = new SwarmClient({ name: "queen", role: "queen" });
        const coordA = new SwarmClient({ name: "coord-a", role: "coordinator", swarm: "alpha" });
        const coordB = new SwarmClient({ name: "coord-b", role: "coordinator", swarm: "beta" });
        const a1 = new SwarmClient({ name: "a1", role: "agent", swarm: "alpha" });
        await queen.connect(queenSock);
        await coordA.connect(queenSock);
        await coordB.connect(queenSock);
        await a1.connect(queenSock);

        const receivedQueen: any[] = [];
        const receivedB: any[] = [];
        const receivedA1: any[] = [];
        queen.on("message", (msg) => receivedQueen.push(msg));
        coordB.on("message", (msg) => receivedB.push(msg));
        a1.on("message", (msg) => receivedA1.push(msg));

        coordA.instruct("status update: alpha swarm halfway done");
        await delay(50);

        assertEqual(receivedQueen.length, 1, "queen received broadcast");
        assertEqual(receivedB.length, 1, "coord-b received broadcast");
        assertEqual(receivedA1.length, 1, "a1 received broadcast (same swarm as coord-a)");

        queen.disconnect();
        coordA.disconnect();
        coordB.disconnect();
        a1.disconnect();
        await queenServer.stop();
    });

    await test("coordinator instruct targeting unknown agent forwards to peer coordinators", async () => {
        const queenSock = tmpSocketPath();
        const queenServer = new SwarmServer(new UnixTransportServer(queenSock));
        await queenServer.start();

        const coordA = new SwarmClient({ name: "coord-a", role: "coordinator", swarm: "alpha" });
        const coordB = new SwarmClient({ name: "coord-b", role: "coordinator", swarm: "beta" });
        await coordA.connect(queenSock);
        await coordB.connect(queenSock);

        const receivedB: any[] = [];
        const errorsA: string[] = [];
        coordB.on("message", (msg) => receivedB.push(msg));
        coordA.on("error", (msg) => errorsA.push(msg));

        coordA.instruct("focus on auth", "b1");
        await delay(50);

        assertEqual(receivedB.length, 0, "server doesn't forward unknown targets to coordinators");
        assertEqual(errorsA.length, 1, "coord-a gets error about no valid recipients");

        coordA.disconnect();
        coordB.disconnect();
        await queenServer.stop();
    });

    await test("coordinator instruct does NOT reach agents in other swarm", async () => {
        const queenSock = tmpSocketPath();
        const queenServer = new SwarmServer(new UnixTransportServer(queenSock));
        await queenServer.start();

        const coordA = new SwarmClient({ name: "coord-a", role: "coordinator", swarm: "alpha" });
        const b1 = new SwarmClient({ name: "b1", role: "agent", swarm: "beta" });
        await coordA.connect(queenSock);
        await b1.connect(queenSock);

        const receivedB1: any[] = [];
        const errorsA: string[] = [];
        b1.on("message", (msg) => receivedB1.push(msg));
        coordA.on("error", (msg) => errorsA.push(msg));

        coordA.instruct("do something", "b1");
        await delay(50);

        assertEqual(receivedB1.length, 0, "b1 not reachable by coord-a (different swarm)");
        assertEqual(errorsA.length, 1, "coord-a gets error about no valid recipients");

        coordA.disconnect();
        b1.disconnect();
        await queenServer.stop();
    });

    await test("coordinator instruct targets swarm of own agents only", async () => {
        const queenSock = tmpSocketPath();
        const queenServer = new SwarmServer(new UnixTransportServer(queenSock));
        await queenServer.start();

        const coordA = new SwarmClient({ name: "coord-a", role: "coordinator", swarm: "alpha" });
        const a1 = new SwarmClient({ name: "a1", role: "agent", swarm: "alpha" });
        const b1 = new SwarmClient({ name: "b1", role: "agent", swarm: "beta" });
        await coordA.connect(queenSock);
        await a1.connect(queenSock);
        await b1.connect(queenSock);

        const receivedA1: any[] = [];
        const receivedB1: any[] = [];
        a1.on("message", (msg) => receivedA1.push(msg));
        b1.on("message", (msg) => receivedB1.push(msg));

        coordA.instruct("wrap up", undefined, "alpha");
        await delay(50);

        assertEqual(receivedA1.length, 1, "a1 received (same swarm)");
        assertEqual(receivedB1.length, 0, "b1 did NOT receive (different swarm)");

        coordA.disconnect();
        a1.disconnect();
        b1.disconnect();
        await queenServer.stop();
    });
}

main().then(() => summarize());
