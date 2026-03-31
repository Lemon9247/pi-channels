import * as path from "node:path";
import * as crypto from "node:crypto";
import { Mesh, type MessageMeta, type Message } from "agent-channels";
import { loadConfig, shouldAutoRegister } from "./config.js";
import { generateUniqueName } from "./names.js";
import * as registry from "./registry.js";
import * as reservations from "./reservations.js";
import * as presence from "./presence.js";
import * as feed from "./feed.js";
import * as overlay from "./overlay.js";
import { toolDefinition, executeTool } from "./tool.js";
import {
    type ChannelsConfig,
    type ToolAction,
    type RegistryEntry,
} from "./types.js";

// ─── Extension State ────────────────────────────────────────────────

let mesh: Mesh | null = null;
let config: ChannelsConfig;
let agentName = "";
let projectDir = "";
let overlayState = overlay.createOverlayState();
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let activityFlushTimer: ReturnType<typeof setTimeout> | null = null;

// ─── Helpers ────────────────────────────────────────────────────────

function folderHash(dir: string): string {
    return crypto.createHash("sha256").update(dir).digest("hex").slice(0, 12);
}

function getSocketDir(): string {
    const hash = folderHash(projectDir);
    return path.join("/tmp", "pi-channels", hash);
}

function getBranch(): string | undefined {
    try {
        const { execSync } = require("node:child_process");
        return execSync("git rev-parse --abbrev-ref HEAD", {
            cwd: projectDir,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
        }).trim();
    } catch {
        return undefined;
    }
}

// ─── Pi Extension Interface ─────────────────────────────────────────
//
// Pi extensions export an object with lifecycle hooks and tool/command
// definitions. The pi runtime calls these at the appropriate times.
//
// We define a "pi" interface for the methods we expect from the runtime.
// This keeps us decoupled from pi internals.

interface PiContext {
    /** Send a message to the agent's conversation. */
    sendMessage(text: string, options?: { display?: boolean; triggerTurn?: boolean; deliverAs?: string }): void;
    /** Get the current working directory. */
    cwd: string;
    /** Get the model name. */
    model?: string;
}

let pi: PiContext | null = null;

// ─── Mesh Event Handlers ────────────────────────────────────────────

function onMeshMessage(msg: Message, meta: MessageMeta): void {
    if (!pi) return;

    // Handle reservation messages
    if (msg.data?.type === "reserve") {
        const from = msg.data.from as string;
        if (from !== agentName) {
            const paths = msg.data.paths as string[];
            const reason = msg.data.reason as string;
            reservations.setReservations(from, [
                ...reservations.getReservations(from),
                { paths, reason, agent: from, timestamp: new Date().toISOString() },
            ]);
        }
    }

    // Add to overlay
    const chatMsg: overlay.ChatMessage = {
        timestamp: new Date(),
        from: meta.from,
        text: msg.msg,
        channel: meta.channel,
        isDM: meta.channel === "dm",
    };
    overlay.addMessage(overlayState, chatMsg);

    // Deliver to agent based on chattiness
    if (meta.from === agentName) return; // Don't deliver own messages

    if (config.chattiness === "quiet") {
        pi.sendMessage(`📨 [${meta.channel}] ${meta.from}: ${msg.msg}`, {
            display: true,
            triggerTurn: false,
        });
    } else {
        pi.sendMessage(`📨 [${meta.channel}] ${meta.from}: ${msg.msg}`, {
            display: true,
            triggerTurn: true,
            deliverAs: "steer",
        });
    }
}

function onMeshJoin(name: string, channel: string): void {
    if (!pi || name === agentName) return;

    if (config.chattiness !== "quiet") {
        const entry = registry.getAgent(name);
        const branchInfo = entry?.branch ? ` on ${entry.branch}` : "";
        const modelInfo = entry?.model ? `, ${entry.model}` : "";
        pi.sendMessage(`📢 ${name} joined #${channel} (${projectDir}${branchInfo}${modelInfo})`, {
            display: true,
            triggerTurn: false,
        });
    }

    overlay.addMessage(overlayState, {
        timestamp: new Date(),
        from: "system",
        text: `📢 ${name} joined`,
        channel,
        isDM: false,
    });
}

function onMeshLeave(name: string, channel: string): void {
    if (!pi || name === agentName) return;

    if (config.chattiness !== "quiet") {
        pi.sendMessage(`📢 ${name} left #${channel}`, {
            display: true,
            triggerTurn: false,
        });
    }

    // Clean up their reservations
    reservations.clearReservations(name);

    overlay.addMessage(overlayState, {
        timestamp: new Date(),
        from: "system",
        text: `📢 ${name} left`,
        channel,
        isDM: false,
    });
}

// ─── Extension Export ───────────────────────────────────────────────

export default {
    name: "channels",
    version: "0.1.0",
    description: "Inter-session agent communication",

    // ── Tools ─────────────────────────────────────────────────────

    tools: [toolDefinition],

    // ── Commands ──────────────────────────────────────────────────

    commands: [
        {
            name: "channels",
            description: "Manage agent channels",
            args: [
                { name: "subcommand", description: "chat | config | status", required: false },
            ],
            run: async (args: { subcommand?: string }) => {
                switch (args.subcommand) {
                    case "chat":
                        overlayState.visible = !overlayState.visible;
                        if (overlayState.visible) {
                            overlay.clearFocusedUnread(overlayState);
                        }
                        return overlayState.visible ? "Chat overlay opened (Ctrl+H to close)" : "Chat overlay closed";

                    case "status":
                        if (!mesh) return "Not connected to mesh.";
                        return executeTool({ action: "status" }, { mesh, config, agentName, projectDir });

                    case "config":
                        return executeTool({ action: "config.show" }, { mesh, config, agentName, projectDir });

                    default:
                        return [
                            "📡 Channels",
                            "",
                            "  /channels chat     — toggle chat overlay",
                            "  /channels status   — show status",
                            "  /channels config   — show config",
                            "",
                            `  Agent: ${agentName || "not registered"}`,
                            mesh ? `  Channels: ${mesh.channels.map((c) => `#${c}`).join(", ")}` : "  Not connected",
                            `  Peers: ${mesh ? mesh.allMembers().filter((n) => n !== agentName).join(", ") || "none" : "none"}`,
                        ].join("\n");
                }
            },
        },
    ],

    // ── Lifecycle Hooks ──────────────────────────────────────────

    async onSessionStart(ctx: PiContext): Promise<void> {
        pi = ctx;
        projectDir = ctx.cwd;
        config = loadConfig(projectDir);

        // Clean up stale registry entries
        const cleaned = registry.cleanupStaleEntries();
        if (cleaned.length > 0) {
            // Silent cleanup — don't notify unless verbose
            if (config.chattiness === "verbose") {
                pi.sendMessage(`🧹 Cleaned ${cleaned.length} stale agent entries: ${cleaned.join(", ")}`, {
                    display: true,
                    triggerTurn: false,
                });
            }
        }

        // Prune activity feed
        feed.pruneEvents(projectDir, config.feedRetention);

        // Check if we should auto-register
        if (!shouldAutoRegister(config, projectDir)) return;

        // Determine agent name
        agentName = process.env.PI_AGENT_NAME
            || generateUniqueName(config.nameTheme, registry.registeredNames(), config.nameWords);

        // Create mesh
        const socketDir = getSocketDir();
        mesh = new Mesh({
            name: agentName,
            dir: socketDir,
            historySize: 100,
        });

        // Wire up events
        mesh.on("message", onMeshMessage);
        mesh.on("join", onMeshJoin);
        mesh.on("leave", onMeshLeave);
        mesh.on("error", (err: Error) => {
            if (pi) {
                pi.sendMessage(`⚠️ Channels error: ${err.message}`, {
                    display: true,
                    triggerTurn: false,
                });
            }
        });

        // Join mesh
        await mesh.join();

        // Auto-join channels from env var
        const autoJoinChannels = process.env.PI_CHANNELS_JOIN;
        if (autoJoinChannels) {
            for (const ch of autoJoinChannels.split(",").filter(Boolean)) {
                await mesh.join(ch.trim());
            }
        }

        // Register in file-based registry
        const entry: RegistryEntry = {
            name: agentName,
            pid: process.pid,
            cwd: projectDir,
            model: ctx.model,
            branch: getBranch(),
            reservations: [],
            joinedAt: new Date().toISOString(),
            lastActivity: new Date().toISOString(),
            status: "active",
            spawnedBy: process.env.PI_CHANNELS_SPAWNED_BY,
            channels: mesh.channels,
        };
        registry.registerAgent(entry);

        // Log join event
        feed.appendEvent(projectDir, "join", agentName, `Joined mesh`);

        // Start heartbeat (15s interval)
        heartbeatTimer = setInterval(() => {
            presence.flushActivityToRegistry(agentName, config);
        }, 15_000);

        // Notify
        const spawner = process.env.PI_CHANNELS_SPAWNED_BY;
        const spawnNote = spawner ? ` (spawned by ${spawner})` : "";
        pi.sendMessage(
            `🐾 Registered as ${agentName}${spawnNote} — ${mesh.allMembers().length} agents in mesh`,
            { display: true, triggerTurn: false },
        );
    },

    async onToolCall(toolName: string, params: Record<string, unknown>): Promise<{ block: boolean; reason?: string } | undefined> {
        // Handle pi_channels tool calls
        if (toolName === "pi_channels") {
            const result = await executeTool(params as unknown as ToolAction, {
                mesh,
                config,
                agentName,
                projectDir,
            });
            // Return result as a message (pi will show it to the agent)
            if (pi) {
                pi.sendMessage(result, { display: true, triggerTurn: false });
            }
            return undefined;
        }

        // Track activity
        presence.recordActivity(toolName);

        // Check file reservations on write/edit
        if ((toolName === "write" || toolName === "edit") && params.path) {
            const conflict = reservations.checkConflict(
                params.path as string,
                agentName,
                projectDir,
            );
            if (conflict) {
                return {
                    block: true,
                    reason: [
                        `${params.path}`,
                        `Reserved by: ${conflict.agent}`,
                        `Reason: "${conflict.reservation.reason}"`,
                        ``,
                        `Coordinate via pi_channels({ action: "send", to: "${conflict.agent}", message: "..." })`,
                    ].join("\n"),
                };
            }
        }

        return undefined;
    },

    onToolResult(toolName: string, _result: unknown): void {
        presence.clearActivity();

        // Debounced activity flush
        if (activityFlushTimer) clearTimeout(activityFlushTimer);
        activityFlushTimer = setTimeout(() => {
            if (agentName) {
                presence.flushActivityToRegistry(agentName, config);
            }
        }, 10_000);

        // Auto-status in verbose mode
        if (config.chattiness === "verbose" && mesh && presence.canSendAutoStatus()) {
            const toolCount = presence.getToolCount();
            if (toolCount > 10 && toolName === "edit") {
                mesh.send(`🔥 ${agentName} is on fire (${toolCount} edits this session)`);
            }
        }
    },

    onTurnEnd(): void {
        // Check for stuck agents
        if (mesh && config.stuckNotify) {
            const stuck = presence.checkStuckAgents(agentName, config);
            for (const s of stuck) {
                if (pi) {
                    pi.sendMessage(`⚠️ ${s.name} appears stuck (${s.reason})`, {
                        display: true,
                        triggerTurn: false,
                    });
                }
            }
        }
    },

    async onSessionShutdown(): Promise<void> {
        // Stop heartbeat
        if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
        }
        if (activityFlushTimer) {
            clearTimeout(activityFlushTimer);
            activityFlushTimer = null;
        }

        if (mesh && agentName) {
            // Log leave event
            feed.appendEvent(projectDir, "leave", agentName, "Left mesh");

            // Release all reservations
            reservations.releaseReservation(agentName);

            // Leave mesh (notifies peers)
            await mesh.leave();
            mesh = null;

            // Unregister
            registry.unregisterAgent(agentName);
        }

        // Reset state
        overlayState = overlay.createOverlayState();
        presence.reset();
        reservations.clearAllReservations();
        pi = null;
    },

    // ── Status Bar ───────────────────────────────────────────────

    getStatusBar(): string | null {
        if (!config?.showWidget || !mesh || !agentName) return null;

        const peers = mesh.allMembers().filter((n) => n !== agentName).length;
        if (peers === 0) return null; // Auto-hide when no peers

        const unread = overlay.getTotalUnread(overlayState);
        return overlay.renderStatusBar(agentName, peers, unread);
    },

    // ── Keybinding ───────────────────────────────────────────────

    keybindings: [
        {
            key: "ctrl+h",
            description: "Toggle chat overlay",
            handler: () => {
                overlayState.visible = !overlayState.visible;
                if (overlayState.visible) {
                    overlay.clearFocusedUnread(overlayState);
                }
            },
        },
    ],

    // ── Overlay Rendering ────────────────────────────────────────

    getOverlay(): string | null {
        if (!overlayState.visible || !mesh) return null;

        return overlay.renderOverlay(overlayState, {
            width: 60,
            height: 20,
            agentName,
            members: mesh.allMembers(),
            channels: mesh.channels,
            projectName: path.basename(projectDir),
        });
    },

    handleOverlayInput(key: string): boolean {
        if (!overlayState.visible) return false;

        switch (key) {
            case "escape":
                overlayState.visible = false;
                return true;

            case "#":
                if (mesh) {
                    overlay.cycleChannel(overlayState, mesh.channels);
                }
                return true;

            case "return": {
                if (!overlayState.inputBuffer.trim() || !mesh) return true;

                const parsed = overlay.parseInput(overlayState.inputBuffer.trim());
                if (parsed.type === "dm") {
                    mesh.sendTo(parsed.target, parsed.message).catch(() => {
                        // Target offline
                    });
                } else {
                    const channel = overlayState.focusedChannel === "all" || overlayState.focusedChannel === "dm"
                        ? "general"
                        : overlayState.focusedChannel;
                    mesh.send(parsed.message, { channel });
                }
                overlayState.inputBuffer = "";
                return true;
            }

            case "backspace":
                overlayState.inputBuffer = overlayState.inputBuffer.slice(0, -1);
                return true;

            case "up":
                overlayState.scrollOffset = Math.min(
                    overlayState.scrollOffset + 1,
                    overlayState.messages.length - 1,
                );
                return true;

            case "down":
                overlayState.scrollOffset = Math.max(overlayState.scrollOffset - 1, 0);
                return true;

            default:
                // Regular character
                if (key.length === 1) {
                    overlayState.inputBuffer += key;
                    return true;
                }
                return false;
        }
    },
};
