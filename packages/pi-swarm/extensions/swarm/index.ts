/**
 * Swarm Socket Extension
 *
 * Provides channel-based coordination for multi-agent swarms.
 * Two modes based on environment:
 *
 * - No PI_CHANNELS_GROUP: Queen mode. Can create swarms (channel groups).
 * - PI_CHANNELS_GROUP set: Agent/coordinator mode. Connects as client.
 *
 * The swarm tool is always registered (queen starts swarms, coordinators
 * spawn sub-agents within existing swarms).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createIdentity, getChannelGroupPath, getInboxChannel, getSubscribeChannels } from "./core/identity.js";
import { connectToMultiple } from "./core/channels.js";
import { registerSwarmTool } from "./tools/swarm.js";
import { registerInstructTool } from "./tools/instruct.js";
import { registerStatusTool } from "./tools/status.js";
import { registerAgentTools } from "./tools/agent.js";
import { setupNotifications } from "./ui/notifications.js";
import { cleanupSwarm, setParentClients, getParentClients } from "./core/state.js";
import { GENERAL_CHANNEL, QUEEN_INBOX } from "./core/channels.js";
import { registerMessageRenderers } from "./ui/renderers.js";
import { clearDashboard } from "./ui/dashboard.js";
import { registerSwarmCommand } from "./ui/commands.js";
import { openDashboardOverlay } from "./ui/overlay.js";

export default function (pi: ExtensionAPI) {
    // Initialize identity from environment variables
    const identity = createIdentity();

    const channelGroupPath = getChannelGroupPath();

    if (channelGroupPath && identity.role !== "queen") {
        // We're inside a swarm — connect to channels on session start
        const inboxChannel = getInboxChannel();
        const subscribeChannels = getSubscribeChannels();

        // Build list of channels to connect to.
        // Subscribe channels = channels we listen on for notifications.
        // We also connect to QUEEN_INBOX for sending (done/blocker/progress)
        // but DON'T pass it to setupNotifications — agents shouldn't receive
        // queen-bound messages from other agents (C1 fix).
        const channelNames: string[] = [];
        if (inboxChannel) channelNames.push(inboxChannel);
        for (const ch of subscribeChannels) {
            if (!channelNames.includes(ch)) channelNames.push(ch);
        }
        // Connect for sending only — not in subscribeChannels
        if (!channelNames.includes(QUEEN_INBOX)) {
            channelNames.push(QUEEN_INBOX);
        }

        pi.on("session_start", async (_event, ctx) => {
            try {
                const clients = await connectToMultiple(channelGroupPath, channelNames);
                setParentClients(clients);

                // Set up notifications only on subscribe channels,
                // NOT on QUEEN_INBOX (agents shouldn't process queen-bound traffic)
                const notifyClients = new Map(
                    [...clients].filter(([name]) => name !== QUEEN_INBOX),
                );
                setupNotifications(pi, notifyClients);

                // Send registration message so queen knows we're running
                // Send to both QUEEN_INBOX (primary) and GENERAL (fallback)
                // — same pattern as hive_done/hive_blocker
                const registerMsg = {
                    msg: "register",
                    data: {
                        type: "register",
                        from: identity.name,
                        role: identity.role,
                    },
                };
                const queenClient = clients.get(QUEEN_INBOX);
                if (queenClient?.connected) {
                    queenClient.send(registerMsg);
                }
                const generalClient = clients.get(GENERAL_CHANNEL);
                if (generalClient?.connected) {
                    generalClient.send(registerMsg);
                }

                if (ctx.hasUI) {
                    ctx.ui.setStatus("swarm", `🐝 ${identity.name} (${identity.role})`);
                }
            } catch (err) {
                // Channel connection failed — agent runs without coordination
                if (ctx.hasUI) {
                    ctx.ui.notify(`Channel connection failed: ${err}`, "warning");
                }
            }
        });

        // Register agent notification tools
        registerAgentTools(pi);
    }

    // Register message renderers for all swarm notification types
    registerMessageRenderers(pi);

    // Register /swarm command (interactive dashboard overlay)
    registerSwarmCommand(pi);

    // Register Ctrl+H keybind to open the dashboard overlay
    pi.registerShortcut("ctrl+h", {
        description: "Open agent dashboard overlay",
        handler: async (ctx) => {
            openDashboardOverlay(ctx);
        },
    });

    // Register management tools — only queen and coordinator can spawn sub-agents.
    if (identity.role === "queen" || identity.role === "coordinator") {
        registerSwarmTool(pi);
        registerInstructTool(pi);
        registerStatusTool(pi);
    }

    // Single shutdown handler with correct ordering:
    // 1. Clean up own swarm first (kills sub-agents)
    // 2. Then disconnect from parent channels
    pi.on("session_shutdown", async () => {
        clearDashboard(true);
        await cleanupSwarm();
        // Disconnect parent channel clients
        const clients = getParentClients();
        if (clients) {
            for (const client of clients.values()) {
                try { client.disconnect(); } catch { /* ignore */ }
            }
            setParentClients(null);
        }
    });
}
