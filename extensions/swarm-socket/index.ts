/**
 * Swarm Socket Extension
 *
 * Provides Unix socket-based coordination for multi-agent swarms.
 * Two modes based on environment:
 *
 * - No PI_SWARM_SOCKET: Queen mode. Can create swarms (socket server).
 * - PI_SWARM_SOCKET set: Agent/coordinator mode. Connects as client.
 *
 * The swarm tool is always registered (queen starts swarms, coordinators
 * spawn sub-agents within existing swarms).
 */

import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { SwarmClient } from "./client.js";
import { registerSwarmTool } from "./swarm-tool.js";
import { registerInstructTool } from "./instruct-tool.js";
import { registerStatusTool } from "./status-tool.js";
import { registerAgentTools } from "./agent-tools.js";
import { setupNotifications } from "./notifications.js";
import { cleanupSwarm, setParentClient } from "./state.js";
import { registerMessageRenderers, clearDashboard } from "./dashboard.js";
import { registerSwarmCommand } from "./swarm-command.js";

/** Clean up stale socket files from crashed sessions */
function cleanStaleSockets(): void {
    const tmpDir = os.tmpdir();
    try {
        const entries = fs.readdirSync(tmpDir);
        for (const entry of entries) {
            if (!entry.startsWith("pi-swarm-") || !entry.endsWith(".sock")) continue;
            const sockPath = path.join(tmpDir, entry);
            try {
                // Try connecting — if it fails, the socket is stale
                const sock = net.createConnection(sockPath);
                // If connect succeeds, it's live — disconnect
                sock.on("connect", () => sock.destroy());
                // If it errors, it's stale — remove it
                sock.on("error", () => {
                    try { fs.unlinkSync(sockPath); } catch { /* ignore */ }
                });
                // Timeout after 500ms
                sock.setTimeout(500, () => {
                    sock.destroy();
                    try { fs.unlinkSync(sockPath); } catch { /* ignore */ }
                });
            } catch {
                try { fs.unlinkSync(sockPath); } catch { /* ignore */ }
            }
        }
    } catch { /* ignore tmpdir read errors */ }
}

export default function (pi: ExtensionAPI) {
    // Clean stale sockets on startup (queen mode only)
    if (!process.env.PI_SWARM_SOCKET) {
        cleanStaleSockets();
    }
    const socketPath = process.env.PI_SWARM_SOCKET;
    const agentName = process.env.PI_SWARM_AGENT_NAME;
    const agentRole = process.env.PI_SWARM_AGENT_ROLE as "coordinator" | "agent" | undefined;
    const agentSwarm = process.env.PI_SWARM_AGENT_SWARM;

    if (socketPath && agentName && agentRole) {
        // We're inside a swarm — connect as client
        const client = new SwarmClient({
            name: agentName,
            role: agentRole,
            swarm: agentSwarm,
        });

        // Store as parent client so coordinator can relay through it
        setParentClient(client);

        // Connect on session start
        pi.on("session_start", async (_event, ctx) => {
            try {
                await client.connect(socketPath);
                if (ctx.hasUI) {
                    ctx.ui.setStatus("swarm", `🐝 ${agentName} (${agentRole})`);
                }
            } catch (err) {
                // Socket connection failed — agent runs without coordination
                if (ctx.hasUI) {
                    ctx.ui.notify(`Swarm socket connection failed: ${err}`, "warning");
                }
            }
        });

        // Register agent notification tools
        registerAgentTools(pi, client);

        // Set up incoming message handler
        setupNotifications(pi, client);

        // Shutdown is handled below in the unified handler
    }

    // Register message renderers for all swarm notification types
    registerMessageRenderers(pi);

    // Register /swarm command (interactive dashboard overlay)
    registerSwarmCommand(pi);

    // Register management tools based on role:
    // - Queen (no PI_SWARM_SOCKET): gets swarm + instruct + status
    // - Coordinator: gets swarm + instruct + status (can spawn sub-agents)
    // - Agent: gets NONE of these (agents do work, they don't delegate)
    if (!agentRole || agentRole === "coordinator") {
        registerSwarmTool(pi);
        registerInstructTool(pi);
        registerStatusTool(pi);
    }

    // Single shutdown handler with correct ordering:
    // 1. Clean up own swarm first (kills sub-agents, relays disconnections up)
    // 2. Then disconnect from parent socket
    pi.on("session_shutdown", async () => {
        clearDashboard(true);
        await cleanupSwarm();
        if (socketPath && agentName && agentRole) {
            // We captured client in the closure above
            const pc = getParentClient();
            if (pc) pc.disconnect();
        }
    });
}
