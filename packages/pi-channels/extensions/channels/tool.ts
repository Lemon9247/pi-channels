import { type Mesh } from "agent-channels";
import { type AgentParams, type ChannelParams, type ChannelsConfig, type MsgParams, type ReserveParams } from "./types.js";
import * as registry from "./registry.js";
import * as reservations from "./reservations.js";
import * as terminal from "./terminal.js";
import { generateUniqueName } from "./names.js";

const CHANNEL_NAME_REGEX = /^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/;
const AGENT_ACTION_LIST = "list, whois, status, spawn";
const CHANNEL_ACTION_LIST = "list, join, leave";
const RESERVE_ACTION_LIST = "reserve, release";

export const msgToolDefinition = {
    name: "msg",
    description: "Send a channel message or DM to another pi session",
    parameters: {
        type: "object" as const,
        properties: {
            message: {
                type: "string",
                description: "Message content",
            },
            to: {
                type: "string",
                description: "Agent name for DM",
            },
            channel: {
                type: "string",
                description: "Channel name for group messages. Default: general",
            },
        },
        required: ["message"],
    },
};

export const agentToolDefinition = {
    name: "agent",
    description: "Inspect agents, check your session status, or spawn a new agent. Actions: list, whois, status, spawn",
    parameters: {
        type: "object" as const,
        properties: {
            action: {
                type: "string",
                description: `Action to perform: ${AGENT_ACTION_LIST}`,
            },
            name: {
                type: "string",
                description: "Agent name (whois action)",
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
        },
        required: ["action"],
    },
};

export const channelToolDefinition = {
    name: "channel",
    description: "List, join, or leave channels. Actions: list, join, leave",
    parameters: {
        type: "object" as const,
        properties: {
            action: {
                type: "string",
                description: `Action to perform: ${CHANNEL_ACTION_LIST}`,
            },
            name: {
                type: "string",
                description: "Channel name for join/leave",
            },
        },
        required: ["action"],
    },
};

export const reserveToolDefinition = {
    name: "reserve",
    description: "Reserve or release files for cooperative editing. Omit action or use 'reserve' to claim files; use 'release' to free them.",
    parameters: {
        type: "object" as const,
        properties: {
            action: {
                type: "string",
                description: `Optional action: ${RESERVE_ACTION_LIST}. Default: reserve`,
            },
            paths: {
                type: "array",
                items: { type: "string" },
                description: "File paths to reserve or release",
            },
            reason: {
                type: "string",
                description: "Reason for reservation",
            },
        },
        required: ["paths"],
    },
};

export interface ToolContext {
    mesh: Mesh | null;
    config: ChannelsConfig;
    agentName: string;
    projectDir: string;
    connectToMesh?: () => Promise<string>;
}

async function ensureMesh(context: ToolContext): Promise<Mesh | null> {
    if (context.mesh) return context.mesh;
    if (!context.connectToMesh) return null;
    await context.connectToMesh();
    return context.mesh;
}

function validateChannelName(name: string | undefined): string | null {
    if (!name) return null;
    if (!CHANNEL_NAME_REGEX.test(name)) {
        return `❌ Invalid channel name "${name}". Use letters, digits, underscores, hyphens. Start with a letter. Max 32 chars.`;
    }
    return null;
}

export async function executeMsgTool(params: MsgParams, context: ToolContext): Promise<string> {
    if (!params.message) return "❌ Specify a message.";
    const nameError = validateChannelName(params.channel);
    if (nameError) return nameError;

    const mesh = await ensureMesh(context);
    if (!mesh) return "❌ Not connected to mesh.";

    if (params.to) {
        try {
            await mesh.sendTo(params.to, params.message);
            return `✅ Sent DM to ${params.to}`;
        } catch (err) {
            return `❌ ${(err as Error).message}`;
        }
    }

    const channel = params.channel ?? "general";
    mesh.send(params.message, { channel });
    return `✅ Sent to #${channel}`;
}

export async function executeAgentTool(params: AgentParams, context: ToolContext): Promise<string> {
    switch (params.action) {
        case "list": {
            const agents = registry.listAgentsForProject(context.projectDir);
            if (agents.length === 0) return "No agents registered.";

            const lines = agents.map((agent) => {
                const emoji = registry.statusEmoji(agent.status);
                const suffix = agent.name === context.agentName ? " (you)" : "";
                const branch = agent.branch ? ` on ${agent.branch}` : "";
                return `  ${emoji} ${agent.name}${suffix} — ${agent.cwd}${branch}`;
            });
            return `👥 Agents:\n${lines.join("\n")}`;
        }

        case "status": {
            const mesh = await ensureMesh(context);
            if (!mesh) return "❌ Not connected to mesh.";
            const myEntry = registry.getAgent(context.agentName);
            const peers = mesh.allMembers().filter((name) => name !== context.agentName);
            const resCount = myEntry?.reservations.length ?? 0;
            return [
                `🐾 ${context.agentName} — ${mesh.channels.length} channels, ${peers.length} peers`,
                `   Channels: ${mesh.channels.map((channel) => `#${channel}`).join(", ")}`,
                `   Peers: ${peers.join(", ") || "none"}`,
                `   Reservations: ${resCount}`,
            ].join("\n");
        }

        case "whois": {
            if (!params.name) return "❌ Specify a name.";
            const agent = registry.getAgent(params.name);
            if (!agent) return `❌ Unknown agent: ${params.name}`;
            const emoji = registry.statusEmoji(agent.status);
            return [
                `${emoji} ${agent.name}`,
                `   CWD: ${agent.cwd}`,
                agent.branch ? `   Branch: ${agent.branch}` : null,
                agent.model ? `   Model: ${agent.model}` : null,
                `   Joined: ${agent.joinedAt}`,
                `   Last active: ${agent.lastActivity}`,
                `   Channels: ${agent.channels.join(", ")}`,
                agent.reservations.length > 0
                    ? `   Reservations: ${agent.reservations.map((reservation) => reservation.paths.join(", ")).join("; ")}`
                    : null,
                agent.spawnedBy ? `   Spawned by: ${agent.spawnedBy}` : null,
            ].filter(Boolean).join("\n");
        }

        case "spawn": {
            if (!params.prompt) return "❌ Specify a prompt for the new session.";

            if (!context.agentName) {
                const mesh = await ensureMesh(context);
                if (!mesh) return "❌ Not connected to mesh.";
            }

            const newName = generateUniqueName(
                context.config.nameTheme,
                registry.registeredNames(),
                context.config.nameWords,
            );

            const env: Record<string, string> = {
                PI_CHANNELS_AUTO_REGISTER: "1",
                PI_CHANNELS_SPAWNED_BY: context.agentName,
                PI_AGENT_NAME: newName,
            };
            if (params.channels?.length) {
                env.PI_CHANNELS_JOIN = params.channels.join(",");
            }

            const spawnCwd = params.cwd || context.projectDir;
            if (spawnCwd !== context.projectDir) {
                return `❌ Cannot spawn agent in different folder. Child agents must be in the same directory to join the mesh.\n   Parent: ${context.projectDir}\n   Requested: ${spawnCwd}`;
            }

            const result = terminal.spawnTerminal({
                prompt: params.prompt,
                cwd: context.projectDir,
                terminal: context.config.terminal,
                env,
            });

            if (result.success) {
                return `✅ Spawned ${newName} in ${result.terminal} terminal\n   Prompt: "${params.prompt}"`;
            }

            return [
                `⚠️ Could not auto-open terminal. Run this command manually:`,
                "",
                `   ${result.command}`,
                "",
                `   (Agent name: ${newName})`,
            ].join("\n");
        }

        default:
            return `❌ Unknown action: ${params.action}. Valid: ${AGENT_ACTION_LIST}`;
    }
}

export async function executeChannelTool(params: ChannelParams, context: ToolContext): Promise<string> {
    const nameError = validateChannelName(params.name);
    if (nameError) return nameError;

    switch (params.action) {
        case "list": {
            const mesh = await ensureMesh(context);
            if (!mesh) return "❌ Not connected to mesh.";

            const lines = mesh.channels.map((channel) => {
                const members = mesh.channelMembers(channel);
                return `  #${channel} (${members.length} members: ${members.join(", ")})`;
            });
            return `📡 Channels:\n${lines.join("\n")}`;
        }

        case "join": {
            const mesh = await ensureMesh(context);
            if (!mesh) return "❌ Not connected to mesh.";
            if (!params.name) {
                return `Already in mesh. Channels: ${mesh.channels.join(", ")}`;
            }

            await mesh.join(params.name);
            mesh.send(`${context.agentName} joined #${params.name}`, { channel: "general" });
            registry.updateAgent(context.agentName, { channels: mesh.channels });
            return `✅ Joined #${params.name} (members: ${mesh.channelMembers(params.name).join(", ")})`;
        }

        case "leave": {
            const mesh = await ensureMesh(context);
            if (!mesh) return "❌ Not connected to mesh.";
            if (!params.name) {
                return "Specify a channel to leave, or use session shutdown to leave all.";
            }
            if (params.name === "general") {
                return "❌ Cannot leave #general.";
            }

            await mesh.leave(params.name);
            registry.updateAgent(context.agentName, { channels: mesh.channels });
            return `✅ Left #${params.name}`;
        }

        default:
            return `❌ Unknown action: ${params.action}. Valid: ${CHANNEL_ACTION_LIST}`;
    }
}

export async function executeReserveTool(params: ReserveParams, context: ToolContext): Promise<string> {
    const action = params.action ?? "reserve";

    switch (action) {
        case "reserve": {
            const mesh = await ensureMesh(context);
            if (!mesh) return "❌ Not connected to mesh.";
            if (!params.paths?.length) return "❌ Specify paths to reserve.";

            for (const value of params.paths) {
                const conflict = reservations.checkConflict(value, context.agentName, context.projectDir);
                if (conflict) {
                    return [
                        `❌ ${value}`,
                        `   Reserved by: ${conflict.agent}`,
                        `   Reason: "${conflict.reservation.reason}"`,
                        "",
                        `   Coordinate via msg({ to: "${conflict.agent}", message: "..." })`,
                    ].join("\n");
                }
            }

            const entry = registry.getAgent(context.agentName);
            const nextReservations = reservations.addReservation(
                entry?.reservations ?? [],
                context.agentName,
                params.paths,
                params.reason ?? "Working on these files",
            );
            registry.updateAgent(context.agentName, { reservations: nextReservations });
            mesh.send(`${context.agentName} reserved ${params.paths.join(", ")} — ${params.reason ?? "Working on these files"}`);
            return `✅ Reserved: ${params.paths.join(", ")} (${params.reason ?? "Working on these files"})`;
        }

        case "release": {
            const mesh = await ensureMesh(context);
            if (!mesh) return "❌ Not connected to mesh.";
            if (!params.paths?.length) return "❌ Specify paths to release.";

            const entry = registry.getAgent(context.agentName);
            const { kept, released } = reservations.releaseReservations(entry?.reservations ?? [], params.paths);
            if (released.length === 0) return "No matching reservations to release.";

            registry.updateAgent(context.agentName, { reservations: kept });
            const releasedPaths = released.flatMap((reservation) => reservation.paths);
            mesh.send(`${context.agentName} released ${releasedPaths.join(", ")}`);
            return `✅ Released: ${releasedPaths.join(", ")}`;
        }

        default:
            return `❌ Unknown action: ${action}. Valid: ${RESERVE_ACTION_LIST}`;
    }
}
