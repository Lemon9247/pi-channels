import * as path from "node:path";
import { execSync } from "node:child_process";
import { Mesh, type Message, type MessageMeta } from "agent-channels";
import { folderHash, loadConfig, shouldAutoRegister } from "./config.js";
import { generateUniqueName } from "./names.js";
import * as registry from "./registry.js";
import * as reservations from "./reservations.js";
import * as overlay from "./overlay.js";
import { ChannelsOverlay } from "./channels-overlay.js";
import {
    agentToolDefinition,
    channelToolDefinition,
    executeAgentTool,
    executeChannelTool,
    executeMsgTool,
    executeReserveTool,
    msgToolDefinition,
    reserveToolDefinition,
} from "./tool.js";
import {
    DEFAULT_CONFIG,
    type AgentParams,
    type ChannelParams,
    type ChannelsConfig,
    type MsgParams,
    type RegistryEntry,
    type ReserveParams,
} from "./types.js";

interface SessionState {
    mesh: Mesh | null;
    config: ChannelsConfig;
    agentName: string;
    projectDir: string;
    overlayState: overlay.OverlayState;
    heartbeatTimer: ReturnType<typeof setInterval> | null;
    activityFlushTimer: ReturnType<typeof setTimeout> | null;
    latestCtx: any;
    piApi: any;
}

const state: SessionState = {
    mesh: null,
    config: DEFAULT_CONFIG,
    agentName: "",
    projectDir: "",
    overlayState: overlay.createOverlayState(),
    heartbeatTimer: null,
    activityFlushTimer: null,
    latestCtx: null,
    piApi: null,
};

function getSocketDir(projectDir: string): string {
    return path.join("/tmp", "pi-channels", folderHash(projectDir));
}

function getBranch(projectDir: string): string | undefined {
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

function updateStatusBar(ctx?: any): void {
    const current = ctx || state.latestCtx;
    if (!current?.hasUI || !current?.ui?.setStatus) return;

    if (!state.mesh || !state.agentName) {
        current.ui.setStatus("channels", "");
        return;
    }

    const peers = state.mesh.allMembers().filter((name) => name !== state.agentName).length;
    const unread = overlay.getTotalUnread(state.overlayState);
    const theme = current.ui.theme;

    const nameStr = theme?.fg?.("accent", state.agentName) ?? state.agentName;
    const countStr = theme?.fg?.("dim", ` · ${peers} ${peers === 1 ? "spirit" : "spirits"}`) ?? ` · ${peers} peer${peers === 1 ? "" : "s"}`;
    const unreadStr = unread > 0 ? (theme?.fg?.("accent", ` ✧${unread}`) ?? ` ✧${unread}`) : "";
    current.ui.setStatus("channels", `☸ ${nameStr}${countStr}${unreadStr}`);
}

function onMeshMessage(msg: Message, meta: MessageMeta): void {
    if (!state.piApi) return;

    overlay.addMessage(state.overlayState, {
        timestamp: new Date(),
        from: meta.from,
        text: msg.msg,
        channel: meta.channel,
        isDM: meta.channel === "dm",
    }, state.agentName);
    updateStatusBar();

    if (meta.from === state.agentName) return;

    const content = `**Message from ${meta.from}** [${meta.channel}]\n\n${msg.msg}`;
    if (state.config.chattiness === "quiet") {
        state.piApi.sendMessage(
            { customType: "channels-message", content, display: true },
            { triggerTurn: false },
        );
    } else {
        state.piApi.sendMessage(
            { customType: "channels-message", content, display: true },
            { triggerTurn: true, deliverAs: "steer" },
        );
    }
}

function onMeshJoin(name: string, channel: string): void {
    if (!state.piApi || name === state.agentName) return;

    if (state.config.chattiness !== "quiet") {
        const entry = registry.getAgent(name);
        const branchInfo = entry?.branch ? ` on ${entry.branch}` : "";
        const modelInfo = entry?.model ? `, ${entry.model}` : "";
        state.piApi.sendMessage(
            { customType: "channels-system", content: `☽ ${name} joined #${channel} (${state.projectDir}${branchInfo}${modelInfo})`, display: false },
            { triggerTurn: false },
        );
    }

    overlay.addMessage(state.overlayState, {
        timestamp: new Date(),
        from: "system",
        text: `${name} joined #${channel}`,
        channel,
        isDM: false,
    }, state.agentName);
    updateStatusBar();
}

function onMeshLeave(name: string, channel: string): void {
    if (!state.piApi || name === state.agentName) return;

    if (state.config.chattiness !== "quiet") {
        state.piApi.sendMessage(
            { customType: "channels-system", content: `☾ ${name} departed #${channel}`, display: false },
            { triggerTurn: false },
        );
    }

    overlay.addMessage(state.overlayState, {
        timestamp: new Date(),
        from: "system",
        text: `${name} left #${channel}`,
        channel,
        isDM: false,
    }, state.agentName);
    updateStatusBar();
}

async function connectToMesh(model?: string): Promise<string> {
    if (state.mesh) return `Already connected as ${state.agentName}.`;
    if (!state.projectDir) return "No project directory set.";

    state.agentName = process.env.PI_AGENT_NAME
        || generateUniqueName(state.config.nameTheme, registry.registeredNames(), state.config.nameWords);

    const mesh = new Mesh({
        name: state.agentName,
        dir: getSocketDir(state.projectDir),
    });

    mesh.on("message", onMeshMessage);
    mesh.on("join", onMeshJoin);
    mesh.on("leave", onMeshLeave);
    mesh.on("error", (err: Error) => {
        state.piApi?.sendMessage(
            { customType: "channels-system", content: `Channels error: ${err.message}`, display: false },
            { triggerTurn: false },
        );
    });

    await mesh.join();
    state.mesh = mesh;

    const configChannels = state.config.autoJoinChannels ?? ["general"];
    const envChannels = process.env.PI_CHANNELS_JOIN?.split(",").filter(Boolean) ?? [];
    const channelsToJoin = [...new Set([...configChannels, ...envChannels])];
    for (const channel of channelsToJoin) {
        if (channel.trim() && channel !== "general") {
            await mesh.join(channel.trim());
        }
    }

    const entry: RegistryEntry = {
        name: state.agentName,
        pid: process.pid,
        cwd: state.projectDir,
        model,
        branch: getBranch(state.projectDir),
        reservations: [],
        joinedAt: new Date().toISOString(),
        lastActivity: new Date().toISOString(),
        status: "active",
        spawnedBy: process.env.PI_CHANNELS_SPAWNED_BY,
        channels: mesh.channels,
    };
    registry.registerAgent(entry);

    state.heartbeatTimer = setInterval(() => {
        registry.flushActivityToRegistry(state.agentName);
    }, 15_000);

    const spawner = process.env.PI_CHANNELS_SPAWNED_BY;
    const spawnNote = spawner ? ` (summoned by ${spawner})` : "";
    state.piApi?.sendMessage(
        {
            customType: "channels-system",
            content: `☽ ${state.agentName}${spawnNote} crossed the veil — ${mesh.allMembers().length} ${mesh.allMembers().length === 1 ? "spirit" : "spirits"} in the mesh`,
            display: false,
        },
        { triggerTurn: false },
    );

    updateStatusBar();
    return `Connected as ${state.agentName} — ${mesh.allMembers().length} agent(s) in mesh`;
}

async function initSession(cwd: string, model?: string): Promise<void> {
    state.projectDir = cwd;
    state.config = loadConfig(cwd);

    const cleaned = registry.cleanupStaleEntries();
    if (cleaned.length > 0 && state.config.chattiness === "verbose" && state.piApi) {
        state.piApi.sendMessage(
            { customType: "channels-system", content: `☾ ${cleaned.length} departed ${cleaned.length === 1 ? "spirit" : "spirits"} released from the mesh: ${cleaned.join(", ")}`, display: false },
            { triggerTurn: false },
        );
    }

    if (!shouldAutoRegister(state.config, cwd)) return;
    await connectToMesh(model);
}

async function shutdownSession(): Promise<void> {
    if (state.heartbeatTimer) {
        clearInterval(state.heartbeatTimer);
        state.heartbeatTimer = null;
    }
    if (state.activityFlushTimer) {
        clearTimeout(state.activityFlushTimer);
        state.activityFlushTimer = null;
    }

    if (state.mesh && state.agentName) {
        const entry = registry.getAgent(state.agentName);
        if (entry?.reservations.length) {
            registry.updateAgent(state.agentName, { reservations: [] });
        }
        await state.mesh.leave();
        registry.unregisterAgent(state.agentName);
    }

    state.mesh = null;
    state.overlayState = overlay.createOverlayState();
    registry.resetActivity();
    updateStatusBar();
}

async function openChannelsOverlay(ctx: any): Promise<void> {
    if (!ctx?.hasUI || !ctx?.ui?.custom) return;
    if (!state.mesh) {
        await connectToMesh();
    }

    await ctx.ui.custom(
        (tui: any, theme: any, _keybindings: any, done: any) => {
            return new ChannelsOverlay(tui, theme, {
                mesh: state.mesh,
                config: state.config,
                agentName: state.agentName,
                projectDir: state.projectDir,
                overlayState: state.overlayState,
                connectToMesh,
            }, done);
        },
        { overlay: true },
    );

    updateStatusBar(ctx);
}

process.on("exit", () => {
    if (!state.agentName) return;
    try {
        registry.unregisterAgent(state.agentName);
    } catch {
        // Best effort.
    }
});

process.on("uncaughtException", (err) => {
    console.error("[pi-channels] Uncaught exception:", err);
});

export default function channelsExtension(pi: any): void {
    state.piApi = pi;

    const toolContext = () => ({
        get mesh() { return state.mesh; },
        get config() { return state.config; },
        get agentName() { return state.agentName; },
        get projectDir() { return state.projectDir; },
        connectToMesh,
    });

    const registerTextTool = (definition: any, run: (params: any) => Promise<string>) => {
        pi.registerTool({
            ...definition,
            async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
                state.latestCtx = ctx;
                const result = await run(params);
                return {
                    content: [{ type: "text", text: result }],
                    details: {},
                };
            },
        });
    };

    registerTextTool(msgToolDefinition, (params) => executeMsgTool(params as MsgParams, toolContext()));
    registerTextTool(agentToolDefinition, (params) => executeAgentTool(params as AgentParams, toolContext()));
    registerTextTool(channelToolDefinition, (params) => executeChannelTool(params as ChannelParams, toolContext()));
    registerTextTool(reserveToolDefinition, (params) => executeReserveTool(params as ReserveParams, toolContext()));

    pi.registerCommand("channels", {
        description: "Manage channels interactively",
        async handler(_args: string, ctx: any) {
            if (!ctx?.hasUI) return;

            if (!state.mesh) {
                ctx.ui.notify(await connectToMesh(), "info");
            }

            const action = await ctx.ui.select("Channels", [
                "View Agents",
                "View Channels",
                "Send Message",
                "Join Channel",
                "Leave Channel",
                "Open Chat Overlay",
                "Spawn Session",
            ]);
            if (!action) return;

            switch (action) {
                case "View Agents": {
                    const result = await executeAgentTool(
                        { action: "list" },
                        toolContext(),
                    );
                    ctx.ui.notify(result, "info");
                    break;
                }

                case "View Channels": {
                    const result = await executeChannelTool(
                        { action: "list" },
                        toolContext(),
                    );
                    ctx.ui.notify(result, "info");
                    break;
                }

                case "Send Message": {
                    const channel = await ctx.ui.input("Channel", "Channel name (default: general)");
                    const to = await ctx.ui.input("To", "Agent name for DM (leave empty for channel)");
                    const message = await ctx.ui.input("Message", "Message to send");
                    if (!message) return;
                    const result = await executeMsgTool(
                        { channel: channel || undefined, to: to || undefined, message },
                        toolContext(),
                    );
                    ctx.ui.notify(result, "info");
                    break;
                }

                case "Join Channel": {
                    const channel = await ctx.ui.input("Channel", "Channel name to join");
                    if (!channel) return;
                    const result = await executeChannelTool(
                        { action: "join", name: channel },
                        toolContext(),
                    );
                    ctx.ui.notify(result, "info");
                    break;
                }

                case "Leave Channel": {
                    const channel = await ctx.ui.input("Channel", "Channel name to leave");
                    if (!channel) return;
                    const result = await executeChannelTool(
                        { action: "leave", name: channel },
                        toolContext(),
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
                    const result = await executeAgentTool(
                        { action: "spawn", prompt },
                        toolContext(),
                    );
                    ctx.ui.notify(result, "info");
                    break;
                }
            }
        },
    });

    pi.registerShortcut("ctrl+h", {
        description: "Open channels overlay",
        handler: (ctx: any) => {
            void openChannelsOverlay(ctx);
        },
    });

    pi.on("session_start", async (_event: any, ctx: any) => {
        state.latestCtx = ctx;
        await initSession(ctx.cwd, ctx.model?.name);
        updateStatusBar(ctx);
    });

    pi.on("session_shutdown", async () => {
        await shutdownSession();
    });

    pi.on("tool_call", (event: any) => {
        registry.recordActivity(event.toolName);

        if ((event.toolName === "write" || event.toolName === "edit") && event.input?.path) {
            const conflict = reservations.checkConflict(event.input.path as string, state.agentName, state.projectDir);
            if (conflict) {
                return {
                    block: true,
                    reason: [
                        `${event.input.path}`,
                        `Reserved by: ${conflict.agent}`,
                        `Reason: "${conflict.reservation.reason}"`,
                        "",
                        `Coordinate via msg({ to: "${conflict.agent}", message: "..." })`,
                    ].join("\n"),
                };
            }
        }

        return undefined;
    });

    pi.on("tool_result", (event: any, ctx: any) => {
        state.latestCtx = ctx;
        registry.clearActivity();

        if (state.activityFlushTimer) {
            clearTimeout(state.activityFlushTimer);
        }
        state.activityFlushTimer = setTimeout(() => {
            if (state.agentName) {
                registry.flushActivityToRegistry(state.agentName);
            }
        }, 10_000);

        if (state.config.chattiness === "verbose" && state.mesh && registry.canSendAutoStatus()) {
            const toolCount = registry.getToolCount();
            if (toolCount > 10 && event.toolName === "edit") {
                state.mesh.send(`${state.agentName} is stirring (${toolCount} edits this session)`);
            }
        }
    });

    pi.on("turn_end", (_event: any, ctx: any) => {
        state.latestCtx = ctx;
        updateStatusBar(ctx);
    });
}
