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
import { ChannelsOverlay } from "./channels-overlay.js";
import {
    type ChannelsConfig,
    type ToolAction,
    type RegistryEntry,
} from "./types.js";

// --- Extension State ---

let mesh: Mesh | null = null;
let config: ChannelsConfig;
let agentName = "";
let projectDir = "";
let overlayState = overlay.createOverlayState();
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let activityFlushTimer: ReturnType<typeof setTimeout> | null = null;
let latestCtx: any = null;

// Reference to the pi API (set once in the factory)
let piApi: any = null;

// --- Helpers ---

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

// --- Status Bar ---

function updateStatusBar(ctx?: any): void {
    const c = ctx || latestCtx;
    if (!c?.hasUI || !c?.ui?.setStatus) return;
    if (!mesh || !agentName) {
        c.ui.setStatus("channels", "");
        return;
    }

    const peers = mesh.allMembers().filter((n: string) => n !== agentName).length;
    const unread = overlay.getTotalUnread(overlayState);
    const theme = c.ui.theme;

    const nameStr = theme?.fg?.("accent", agentName) ?? agentName;
    const countStr = theme?.fg?.("dim", ` (${peers} peer${peers === 1 ? "" : "s"})`) ?? ` (${peers} peers)`;
    const unreadStr = unread > 0 ? (theme?.fg?.("accent", ` \u25cf${unread}`) ?? ` \u25cf${unread}`) : "";

    c.ui.setStatus("channels", `ch: ${nameStr}${countStr}${unreadStr}`);
}

// --- Mesh Event Handlers ---

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
    overlay.addMessage(overlayState, chatMsg, agentName);

    // Update status bar to show unread
    updateStatusBar();

    // Deliver to agent based on chattiness
    if (meta.from === agentName) return;

    const content = `**Message from ${meta.from}** [${meta.channel}]\n\n${msg.msg}`;
    if (config.chattiness === "quiet") {
        piApi.sendMessage(
            { customType: "channels-message", content, display: true },
            { triggerTurn: false },
        );
    } else {
        piApi.sendMessage(
            { customType: "channels-message", content, display: true },
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
            { customType: "channels-system", content: `${name} joined #${channel} (${projectDir}${branchInfo}${modelInfo})`, display: false },
            { triggerTurn: false },
        );
    }

    overlay.addMessage(overlayState, {
        timestamp: new Date(),
        from: "system",
        text: `${name} joined #${channel}`,
        channel,
        isDM: false,
    }, agentName);

    updateStatusBar();
}

function onMeshLeave(name: string, channel: string): void {
    if (!piApi || name === agentName) return;

    if (config.chattiness !== "quiet") {
        piApi.sendMessage(
            { customType: "channels-system", content: `${name} left #${channel}`, display: false },
            { triggerTurn: false },
        );
    }

    reservations.clearReservations(name);

    overlay.addMessage(overlayState, {
        timestamp: new Date(),
        from: "system",
        text: `${name} left #${channel}`,
        channel,
        isDM: false,
    }, agentName);

    updateStatusBar();
}

// --- Mesh Connection ---

async function connectToMesh(model?: string): Promise<string> {
    if (mesh) return `Already connected as ${agentName}.`;
    if (!projectDir) return "No project directory set.";

    // Determine agent name
    agentName = process.env.PI_AGENT_NAME
        || generateUniqueName(config.nameTheme, registry.registeredNames(), config.nameWords);

    // Create mesh
    const socketDir = getSocketDir();
    mesh = new Mesh({
        name: agentName,
        dir: socketDir,
    });

    // Wire up events
    mesh.on("message", onMeshMessage);
    mesh.on("join", onMeshJoin);
    mesh.on("leave", onMeshLeave);
    mesh.on("error", (err: Error) => {
        if (piApi) {
            piApi.sendMessage(
                { customType: "channels-system", content: `Channels error: ${err.message}`, display: false },
                { triggerTurn: false },
            );
        }
    });

    // Join mesh
    await mesh.join();

    // Auto-join channels from config and env var
    const configChannels = config?.autoJoinChannels ?? ["general"];
    const envChannels = process.env.PI_CHANNELS_JOIN?.split(",").filter(Boolean) ?? [];
    const channelsToJoin = [...new Set([...configChannels, ...envChannels])];
    for (const ch of channelsToJoin) {
        if (ch.trim() && ch !== "general") {  // general already joined
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
            { customType: "channels-system", content: `Registered as ${agentName}${spawnNote} \u2014 ${mesh.allMembers().length} agents in mesh`, display: false },
            { triggerTurn: false },
        );
    }

    updateStatusBar();

    const peers = mesh.allMembers().length;
    return `Connected as ${agentName} \u2014 ${peers} agent(s) in mesh`;
}

// --- Session Init ---

async function initSession(cwd: string, model?: string): Promise<void> {
    projectDir = cwd;
    config = loadConfig(projectDir);

    // Clean up stale registry entries
    const cleaned = registry.cleanupStaleEntries();
    if (cleaned.length > 0 && config.chattiness === "verbose" && piApi) {
        piApi.sendMessage(
            { customType: "channels-system", content: `Cleaned ${cleaned.length} stale agent entries: ${cleaned.join(", ")}`, display: false },
            { triggerTurn: false },
        );
    }

    // Prune activity feed
    feed.pruneEvents(projectDir, config.feedRetention);

    // Check if we should auto-register
    if (!shouldAutoRegister(config, projectDir)) return;

    await connectToMesh(model);
}

// --- Session Shutdown ---

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

// --- Extension Factory (pi API) ---

export default function channelsExtension(pi: any): void {
    piApi = pi;

    // -- Tool Registration --

    pi.registerTool({
        name: "pi_channels",
        label: "Channels",
        description:
            "Communicate with other pi sessions. Actions: connect, join, leave, send, list, status, whois, channels, feed, reserve, release, spawn, set_status, rename, config.show, config.set",
        parameters: {
            type: "object",
            properties: {
                action: {
                    type: "string",
                    description:
                        "Action to perform: connect | join | leave | send | list | status | whois | channels | feed | reserve | release | spawn | set_status | rename | config.show | config.set",
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
            latestCtx = ctx;
            const result = await executeTool(params as ToolAction, {
                mesh,
                config,
                agentName,
                projectDir,
                connectToMesh,
            });
            return {
                content: [{ type: "text", text: result }],
                details: {},
            };
        },
    });

    // -- Overlay helper --

    async function openChannelsOverlay(ctx: any): Promise<void> {
        if (!ctx?.hasUI || !ctx?.ui?.custom) return;

        // Auto-connect if not registered
        if (!mesh) {
            await connectToMesh();
        }

        await ctx.ui.custom(
            (tui: any, theme: any, _keybindings: any, done: any) => {
                return new ChannelsOverlay(tui, theme, {
                    mesh,
                    config,
                    agentName,
                    projectDir,
                    overlayState,
                    connectToMesh,
                }, done);
            },
            { overlay: true },
        );

        // After overlay closes, update status
        updateStatusBar(ctx);
    }

    // -- Command Registration --

    pi.registerCommand("channels", {
        description: "Manage channels interactively",
        async handler(_args: string, ctx: any) {
            if (!ctx?.hasUI) return;

            // Auto-connect if not registered
            if (!mesh) {
                const msg = await connectToMesh();
                ctx.ui.notify(msg, "info");
            }

            const action = await ctx.ui.select("Channels", [
                "View Agents",
                "View Channels",
                "Send Message",
                "Join Channel",
                "Leave Channel",
                "View Activity Feed",
                "Open Chat Overlay",
                "Spawn Session",
            ]);

            if (!action) return;

            switch (action) {
                case "View Agents": {
                    const agents = registry.listAgentsForProject(projectDir);
                    if (agents.length === 0) {
                        ctx.ui.notify("No agents registered", "info");
                        return;
                    }
                    const lines = agents.map((a) => {
                        const emoji = presence.statusEmoji(a.status);
                        const suffix = a.name === agentName ? " (you)" : "";
                        const branch = a.branch ? ` on ${a.branch}` : "";
                        return `  ${emoji} ${a.name}${suffix}${branch}`;
                    });
                    ctx.ui.notify(["Agents:", ""].concat(lines).join("\n"), "info");
                    break;
                }

                case "View Channels": {
                    if (!mesh) {
                        ctx.ui.notify("Not connected to mesh", "error");
                        return;
                    }
                    const lines = mesh.channels.map((ch) => {
                        const members = mesh.channelMembers(ch);
                        return `  #${ch} (${members.length} members: ${members.join(", ")})`;
                    });
                    ctx.ui.notify(["Channels:", ""].concat(lines).join("\n"), "info");
                    break;
                }

                case "Send Message": {
                    if (!mesh) {
                        ctx.ui.notify("Not connected to mesh", "error");
                        return;
                    }
                    const channel = await ctx.ui.input("Channel", "Channel name (default: general)");
                    const to = await ctx.ui.input("To", "Agent name for DM (leave empty for channel)");
                    const message = await ctx.ui.input("Message", "Message to send");
                    if (!message) return;

                    const result = await executeTool(
                        { action: "send", channel: channel || "general", to: to || undefined, message },
                        { mesh, config, agentName, projectDir, connectToMesh },
                    );
                    ctx.ui.notify(result, "info");
                    break;
                }

                case "Join Channel": {
                    if (!mesh) {
                        ctx.ui.notify("Not connected to mesh", "error");
                        return;
                    }
                    const channel = await ctx.ui.input("Channel", "Channel name to join");
                    if (!channel) return;
                    const result = await executeTool(
                        { action: "join", channel },
                        { mesh, config, agentName, projectDir, connectToMesh },
                    );
                    ctx.ui.notify(result, "info");
                    break;
                }

                case "Leave Channel": {
                    if (!mesh) {
                        ctx.ui.notify("Not connected to mesh", "error");
                        return;
                    }
                    const channel = await ctx.ui.input("Channel", "Channel name to leave");
                    if (!channel) return;
                    const result = await executeTool(
                        { action: "leave", channel },
                        { mesh, config, agentName, projectDir, connectToMesh },
                    );
                    ctx.ui.notify(result, "info");
                    break;
                }

                case "View Activity Feed": {
                    const limitStr = await ctx.ui.input("Limit", "Number of events (default: 20)");
                    const limit = limitStr ? parseInt(limitStr, 10) : 20;
                    const result = await executeTool(
                        { action: "feed", limit: isNaN(limit) ? 20 : limit },
                        { mesh, config, agentName, projectDir, connectToMesh },
                    );
                    ctx.ui.notify(result, "info");
                    break;
                }

                case "Open Chat Overlay": {
                    await openChannelsOverlay(ctx);
                    break;
                }

                case "Spawn Session": {
                    const prompt = await ctx.ui.input("Prompt", "Prompt for new session");
                    if (!prompt) return;
                    const result = await executeTool(
                        { action: "spawn", prompt },
                        { mesh, config, agentName, projectDir, connectToMesh },
                    );
                    ctx.ui.notify(result, "info");
                    break;
                }
            }
        },
    });

    // -- Keyboard Shortcut --

    pi.registerShortcut("ctrl+h", {
        description: "Open channels overlay",
        handler: (ctx: any) => {
            openChannelsOverlay(ctx);
        },
    });

    // -- Lifecycle Events --

    pi.on("session_start", async (_event: any, ctx: any) => {
        latestCtx = ctx;
        const cwd = ctx.cwd;
        const model = ctx.model?.name;
        await initSession(cwd, model);
        updateStatusBar(ctx);
    });

    pi.on("session_shutdown", async () => {
        await shutdownSession();
    });

    // -- Tool Call Hook (reservation enforcement) --

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

    // -- Tool Result Hook (activity tracking) --

    pi.on("tool_result", (event: any, ctx: any) => {
        latestCtx = ctx;
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
                mesh.send(`${agentName} is on fire (${toolCount} edits this session)`);
            }
        }
    });

    // -- Turn End Hook (stuck detection + status) --

    pi.on("turn_end", (_event: any, ctx: any) => {
        latestCtx = ctx;

        if (mesh && config?.stuckNotify) {
            const stuck = presence.checkStuckAgents(agentName, config, projectDir);
            for (const s of stuck) {
                if (ctx?.hasUI) {
                    ctx.ui.notify(`${s.name} appears stuck (${s.reason})`, "warning");
                }
            }
        }

        // Update status bar
        updateStatusBar(ctx);
    });
}
