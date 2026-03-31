import * as path from "node:path";
import * as crypto from "node:crypto";
import { execSync } from "node:child_process";
import { Mesh, type MessageMeta, type Message } from "agent-channels";
import { loadConfig, shouldAutoRegister } from "./config.js";
import { generateUniqueName } from "./names.js";
import * as registry from "./registry.js";
import * as reservations from "./reservations.js";
import * as presence from "./presence.js";
import * as feed from "./feed.js";
import * as overlay from "./overlay.js";
import { executeTool } from "./tool.js";
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

// Reference to the pi API (set once in the factory)
let piApi: any = null;

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
        return execSync("git rev-parse --abbrev-ref HEAD", {
            cwd: projectDir,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
        }).trim();
    } catch {
        return undefined;
    }
}

// ─── Mesh Event Handlers ────────────────────────────────────────────

function onMeshMessage(msg: Message, meta: MessageMeta): void {
    if (!piApi) return;

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
    if (meta.from === agentName) return;

    const content = `📨 [${meta.channel}] ${meta.from}: ${msg.msg}`;
    if (config.chattiness === "quiet") {
        piApi.sendMessage(
            { customType: "channels-message", content: [{ type: "text", text: content }], display: true },
            { triggerTurn: false },
        );
    } else {
        piApi.sendMessage(
            { customType: "channels-message", content: [{ type: "text", text: content }], display: true },
            { triggerTurn: true, deliverAs: "steer" },
        );
    }
}

function onMeshJoin(name: string, channel: string): void {
    if (!piApi || name === agentName) return;

    if (config.chattiness !== "quiet") {
        const entry = registry.getAgent(name);
        const branchInfo = entry?.branch ? ` on ${entry.branch}` : "";
        const modelInfo = entry?.model ? `, ${entry.model}` : "";
        piApi.sendMessage(
            { customType: "channels-system", content: [{ type: "text", text: `📢 ${name} joined #${channel} (${projectDir}${branchInfo}${modelInfo})` }], display: true },
            { triggerTurn: false },
        );
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
    if (!piApi || name === agentName) return;

    if (config.chattiness !== "quiet") {
        piApi.sendMessage(
            { customType: "channels-system", content: [{ type: "text", text: `📢 ${name} left #${channel}` }], display: true },
            { triggerTurn: false },
        );
    }

    reservations.clearReservations(name);

    overlay.addMessage(overlayState, {
        timestamp: new Date(),
        from: "system",
        text: `📢 ${name} left`,
        channel,
        isDM: false,
    });
}

// ─── Mesh Connection ────────────────────────────────────────────────

/**
 * Connect to the mesh. Can be called from initSession (auto) or
 * from the tool's "connect" action (manual).
 */
async function connectToMesh(model?: string): Promise<string> {
    if (mesh) return `Already connected as ${agentName}.`;
    if (!projectDir) return "❌ No project directory set.";

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
        if (piApi) {
            piApi.sendMessage(
                { customType: "channels-system", content: [{ type: "text", text: `⚠️ Channels error: ${err.message}` }], display: true },
                { triggerTurn: false },
            );
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
        model,
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
    if (piApi) {
        const spawner = process.env.PI_CHANNELS_SPAWNED_BY;
        const spawnNote = spawner ? ` (spawned by ${spawner})` : "";
        piApi.sendMessage(
            { customType: "channels-system", content: [{ type: "text", text: `🐾 Registered as ${agentName}${spawnNote} — ${mesh.allMembers().length} agents in mesh` }], display: true },
            { triggerTurn: false },
        );
    }

    const peers = mesh.allMembers().length;
    return `✅ Connected as ${agentName} — ${peers} agent(s) in mesh`;
}

// ─── Session Init ───────────────────────────────────────────────────

async function initSession(cwd: string, model?: string): Promise<void> {
    projectDir = cwd;
    config = loadConfig(projectDir);

    // Clean up stale registry entries
    const cleaned = registry.cleanupStaleEntries();
    if (cleaned.length > 0 && config.chattiness === "verbose" && piApi) {
        piApi.sendMessage(
            { customType: "channels-system", content: [{ type: "text", text: `🧹 Cleaned ${cleaned.length} stale agent entries: ${cleaned.join(", ")}` }], display: true },
            { triggerTurn: false },
        );
    }

    // Prune activity feed
    feed.pruneEvents(projectDir, config.feedRetention);

    // Check if we should auto-register
    if (!shouldAutoRegister(config, projectDir)) return;

    await connectToMesh(model);
}

// ─── Session Shutdown ───────────────────────────────────────────────

async function shutdownSession(): Promise<void> {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
    if (activityFlushTimer) {
        clearTimeout(activityFlushTimer);
        activityFlushTimer = null;
    }

    if (mesh && agentName) {
        feed.appendEvent(projectDir, "leave", agentName, "Left mesh");
        reservations.releaseReservation(agentName);
        await mesh.leave();
        mesh = null;
        registry.unregisterAgent(agentName);
    }

    overlayState = overlay.createOverlayState();
    presence.reset();
    reservations.clearAllReservations();
}

// ─── Extension Factory (pi API) ─────────────────────────────────────

export default function channelsExtension(pi: any): void {
    piApi = pi;

    // ── Tool Registration ────────────────────────────────────────

    // We use a plain object schema since we don't want to depend on TypeBox
    // at this level. Pi accepts any JSON Schema-compatible object.
    pi.registerTool({
        name: "pi_channels",
        label: "Channels",
        description:
            "Communicate with other pi sessions. Actions: join, leave, send, list, status, whois, channels, feed, reserve, release, spawn, set_status, rename, config.show, config.set",
        parameters: {
            type: "object",
            properties: {
                action: {
                    type: "string",
                    description:
                        "Action to perform: join | leave | send | list | status | whois | channels | feed | reserve | release | spawn | set_status | rename | config.show | config.set",
                },
                channel: {
                    type: "string",
                    description: "Channel name (for join/leave/send). Default: general",
                },
                to: {
                    type: "string",
                    description: "Agent name for DM (send action)",
                },
                message: {
                    type: "string",
                    description: "Message content (send/set_status actions)",
                },
                paths: {
                    type: "array",
                    items: { type: "string" },
                    description: "File paths (reserve/release actions)",
                },
                reason: {
                    type: "string",
                    description: "Reason for reservation",
                },
                prompt: {
                    type: "string",
                    description: "Prompt for spawned session",
                },
                cwd: {
                    type: "string",
                    description: "Working directory for spawned session",
                },
                channels: {
                    type: "array",
                    items: { type: "string" },
                    description: "Channels for spawned session to auto-join",
                },
                name: {
                    type: "string",
                    description: "Agent name (whois/rename actions)",
                },
                limit: {
                    type: "number",
                    description: "Number of events (feed action). Default: 20",
                },
                key: {
                    type: "string",
                    description: "Config key (config.set action)",
                },
                value: {
                    description: "Config value (config.set action)",
                },
            },
            required: ["action"],
        },

        async execute(
            _toolCallId: string,
            params: any,
            _signal: any,
            _onUpdate: any,
            ctx: any,
        ) {
            const result = await executeTool(params as ToolAction, {
                mesh,
                config,
                agentName,
                projectDir,
            });
            return {
                content: [{ type: "text", text: result }],
                details: {},
            };
        },
    });

    // ── Command Registration ─────────────────────────────────────

    pi.registerCommand("channels", {
        description: "Manage agent channels interactively",
        async handler(_args: string, ctx: any) {
            const action = await ctx.ui.select("📡 Channels", [
                ...(mesh ? [] : ["Connect to Mesh"]),
                "View Status",
                "List Agents",
                "Join Channel",
                "Leave Channel",
                "Send Message",
                "Activity Feed",
                "Toggle Chat Overlay",
                "Spawn Agent",
                "Config",
            ]);

            if (!action) return;

            const toolCtx = { mesh, config, agentName, projectDir, connectToMesh };

            switch (action) {
                case "Connect to Mesh": {
                    const result = await connectToMesh();
                    ctx.ui.notify(result, "info");
                    break;
                }

                case "View Status": {
                    if (!mesh) {
                        ctx.ui.notify("❌ Not connected to mesh.", "error");
                        return;
                    }
                    const result = await executeTool({ action: "status" }, toolCtx);
                    ctx.ui.notify(result, "info");
                    break;
                }

                case "List Agents": {
                    const result = await executeTool({ action: "list" }, toolCtx);
                    ctx.ui.notify(result, "info");
                    break;
                }

                case "Join Channel": {
                    if (!mesh) {
                        ctx.ui.notify("❌ Not connected to mesh. Connect first.", "error");
                        return;
                    }
                    const channel = await ctx.ui.input("Join Channel", "Enter channel name to join");
                    if (!channel) return;
                    const result = await executeTool({ action: "join", channel }, toolCtx);
                    ctx.ui.notify(result, "info");
                    break;
                }

                case "Leave Channel": {
                    if (!mesh) {
                        ctx.ui.notify("❌ Not connected to mesh.", "error");
                        return;
                    }
                    const channels = mesh.channels.filter((c: string) => c !== "general");
                    if (channels.length === 0) {
                        ctx.ui.notify("No channels to leave (cannot leave #general).", "info");
                        return;
                    }
                    const channel = await ctx.ui.select("Leave Channel", channels);
                    if (!channel) return;
                    const result = await executeTool({ action: "leave", channel }, toolCtx);
                    ctx.ui.notify(result, "info");
                    break;
                }

                case "Send Message": {
                    if (!mesh) {
                        ctx.ui.notify("❌ Not connected to mesh.", "error");
                        return;
                    }
                    const target = await ctx.ui.select("Send To", [
                        ...mesh.channels.map((c: string) => `#${c}`),
                        ...mesh.allMembers().filter((n: string) => n !== agentName).map((n: string) => `@${n} (DM)`),
                    ]);
                    if (!target) return;

                    const message = await ctx.ui.input("Message", `Send to ${target}`);
                    if (!message) return;

                    if (target.startsWith("@")) {
                        const to = target.replace(/^@/, "").replace(/ \(DM\)$/, "");
                        const result = await executeTool({ action: "send", to, message }, toolCtx);
                        ctx.ui.notify(result, "info");
                    } else {
                        const channel = target.replace(/^#/, "");
                        const result = await executeTool({ action: "send", channel, message }, toolCtx);
                        ctx.ui.notify(result, "info");
                    }
                    break;
                }

                case "Activity Feed": {
                    const result = await executeTool({ action: "feed", limit: 20 }, toolCtx);
                    ctx.ui.notify(result, "info");
                    break;
                }

                case "Toggle Chat Overlay": {
                    overlayState.visible = !overlayState.visible;
                    if (overlayState.visible) {
                        overlay.clearFocusedUnread(overlayState);
                    }
                    ctx.ui.notify(
                        overlayState.visible ? "Chat overlay opened (Ctrl+H to close)" : "Chat overlay closed",
                        "info",
                    );
                    break;
                }

                case "Spawn Agent": {
                    const prompt = await ctx.ui.input("Spawn Agent", "Enter the prompt/instructions for the new agent");
                    if (!prompt) return;

                    const joinChannels = await ctx.ui.input("Channels", "Channels to auto-join (comma-separated, or leave empty for general)");
                    const channelList = joinChannels
                        ? joinChannels.split(",").map((c: string) => c.trim()).filter(Boolean)
                        : undefined;

                    const result = await executeTool(
                        { action: "spawn", prompt, channels: channelList },
                        toolCtx,
                    );
                    ctx.ui.notify(result, "info");
                    break;
                }

                case "Config": {
                    const configAction = await ctx.ui.select("Config", [
                        "View Config",
                        "Edit Setting",
                    ]);
                    if (!configAction) return;

                    if (configAction === "View Config") {
                        const result = await executeTool({ action: "config.show" }, toolCtx);
                        ctx.ui.notify(result, "info");
                    } else {
                        const key = await ctx.ui.select("Select Setting", Object.keys(config));
                        if (!key) return;
                        const currentVal = (config as any)[key];
                        const value = await ctx.ui.input(
                            `Set ${key}`,
                            `Current: ${JSON.stringify(currentVal)}. Enter new value`,
                        );
                        if (value === null || value === undefined) return;

                        // Parse booleans and numbers
                        let parsed: unknown = value;
                        if (value === "true") parsed = true;
                        else if (value === "false") parsed = false;
                        else if (!isNaN(Number(value)) && value !== "") parsed = Number(value);

                        const result = await executeTool(
                            { action: "config.set", key, value: parsed },
                            toolCtx,
                        );
                        config = loadConfig(projectDir);
                        ctx.ui.notify(result, "info");
                    }
                    break;
                }
            }
        },
    });

    // ── Keyboard Shortcut ────────────────────────────────────────

    pi.registerShortcut("ctrl+h", {
        description: "Toggle channels chat overlay",
        handler: (ctx: any) => {
            overlayState.visible = !overlayState.visible;
            if (overlayState.visible) {
                overlay.clearFocusedUnread(overlayState);
            }
        },
    });

    // ── Lifecycle Events ─────────────────────────────────────────

    pi.on("session_start", async (_event: any, ctx: any) => {
        const cwd = ctx.cwd;
        const model = ctx.model?.name;
        await initSession(cwd, model);
    });

    pi.on("session_shutdown", async () => {
        await shutdownSession();
    });

    // ── Tool Call Hook (reservation enforcement) ─────────────────

    pi.on("tool_call", (event: any, _ctx: any) => {
        // Track activity
        presence.recordActivity(event.toolName);

        // Check file reservations on write/edit
        if ((event.toolName === "write" || event.toolName === "edit") && event.input?.path) {
            const conflict = reservations.checkConflict(
                event.input.path as string,
                agentName,
                projectDir,
            );
            if (conflict) {
                return {
                    block: true,
                    reason: [
                        `${event.input.path}`,
                        `Reserved by: ${conflict.agent}`,
                        `Reason: "${conflict.reservation.reason}"`,
                        ``,
                        `Coordinate via pi_channels({ action: "send", to: "${conflict.agent}", message: "..." })`,
                    ].join("\n"),
                };
            }
        }

        return undefined;
    });

    // ── Tool Result Hook (activity tracking) ─────────────────────

    pi.on("tool_result", (event: any, _ctx: any) => {
        presence.clearActivity();

        // Debounced activity flush
        if (activityFlushTimer) clearTimeout(activityFlushTimer);
        activityFlushTimer = setTimeout(() => {
            if (agentName) {
                presence.flushActivityToRegistry(agentName, config);
            }
        }, 10_000);

        // Auto-status in verbose mode
        if (config?.chattiness === "verbose" && mesh && presence.canSendAutoStatus()) {
            const toolCount = presence.getToolCount();
            if (toolCount > 10 && event.toolName === "edit") {
                mesh.send(`🔥 ${agentName} is on fire (${toolCount} edits this session)`);
            }
        }
    });

    // ── Turn End Hook (stuck detection) ──────────────────────────

    pi.on("turn_end", () => {
        if (mesh && config?.stuckNotify) {
            const stuck = presence.checkStuckAgents(agentName, config);
            for (const s of stuck) {
                piApi.sendMessage(
                    { customType: "channels-system", content: [{ type: "text", text: `⚠️ ${s.name} appears stuck (${s.reason})` }], display: true },
                    { triggerTurn: false },
                );
            }
        }

        // Update status bar
        if (config?.showWidget && mesh && agentName) {
            const peers = mesh.allMembers().filter((n: string) => n !== agentName).length;
            if (peers > 0) {
                const unread = overlay.getTotalUnread(overlayState);
                const statusText = overlay.renderStatusBar(agentName, peers, unread);
                try {
                    piApi.sendMessage(
                        { customType: "channels-status", content: [{ type: "text", text: statusText }], display: false },
                    );
                } catch {
                    // Status bar display is best-effort
                }
            }
        }
    });
}
