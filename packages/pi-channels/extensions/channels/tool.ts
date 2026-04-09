import { type Mesh } from "agent-channels";
import { type ChannelsConfig, type ToolAction } from "./types.js";
import * as registry from "./registry.js";
import * as reservations from "./reservations.js";
import * as terminal from "./terminal.js";
import { generateUniqueName } from "./names.js";

const CHANNEL_NAME_REGEX = /^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/;
const ACTION_LIST = "connect, join, leave, send, list, status, whois, channels, reserve, release, spawn, set_status";

export const toolDefinition = {
    name: "pi_channels",
    description:
        "Communicate with other pi sessions. Actions: connect, join, leave, send, list, status, whois, channels, reserve, release, spawn, set_status",
    parameters: {
        type: "object" as const,
        properties: {
            action: {
                type: "string",
                description: `Action to perform: ${ACTION_LIST}`,
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
                description: "Agent name (whois action)",
            },
        },
        required: ["action"],
    },
};

export interface ToolContext {
    mesh: Mesh | null;
    config: ChannelsConfig;
    agentName: string;
    projectDir: string;
    connectToMesh?: () => Promise<string>;
}

export async function executeTool(params: ToolAction, context: ToolContext): Promise<string> {
    if (params.channel && !CHANNEL_NAME_REGEX.test(params.channel)) {
        return `❌ Invalid channel name "${params.channel}". Use letters, digits, underscores, hyphens. Start with a letter. Max 32 chars.`;
    }

    switch (params.action) {
        case "connect": {
            if (context.mesh) return `Already connected as ${context.agentName}.`;
            if (!context.connectToMesh) return "❌ Connect not available. Try reloading the extension.";
            return await context.connectToMesh();
        }

        case "join": {
            if (!context.mesh) {
                if (!context.connectToMesh) {
                    return "❌ Not connected to mesh. Use connect action first.";
                }
                await context.connectToMesh();
            }

            const mesh = context.mesh;
            if (!mesh) return "❌ Not connected to mesh.";
            if (!params.channel) {
                return `Already in mesh. Channels: ${mesh.channels.join(", ")}`;
            }

            await mesh.join(params.channel);
            mesh.send(`${context.agentName} joined #${params.channel}`, { channel: "general" });
            registry.updateAgent(context.agentName, { channels: mesh.channels });
            return `✅ Joined #${params.channel} (members: ${mesh.channelMembers(params.channel).join(", ")})`;
        }

        case "leave": {
            const mesh = context.mesh;
            if (!mesh) return "❌ Not connected to mesh. Use connect action or /channels command to connect.";
            if (!params.channel) {
                return "Specify a channel to leave, or use session shutdown to leave all.";
            }
            if (params.channel === "general") {
                return "❌ Cannot leave #general.";
            }

            await mesh.leave(params.channel);
            registry.updateAgent(context.agentName, { channels: mesh.channels });
            return `✅ Left #${params.channel}`;
        }

        case "channels": {
            const mesh = context.mesh;
            if (!mesh) return "❌ Not connected to mesh. Use connect action or /channels command to connect.";

            const lines = mesh.channels.map((channel) => {
                const members = mesh.channelMembers(channel);
                return `  #${channel} (${members.length} members: ${members.join(", ")})`;
            });
            return `📡 Channels:\n${lines.join("\n")}`;
        }

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
            const mesh = context.mesh;
            if (!mesh) return "❌ Not connected to mesh. Use connect action or /channels command to connect.";
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

        case "send": {
            const mesh = context.mesh;
            if (!mesh) return "❌ Not connected to mesh. Use connect action or /channels command to connect.";
            if (!params.message) return "❌ Specify a message.";

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

        case "set_status": {
            const mesh = context.mesh;
            if (!mesh) return "❌ Not connected to mesh. Use connect action or /channels command to connect.";
            if (!params.message) return "❌ Specify a status message.";

            mesh.send(`📋 ${context.agentName}: ${params.message}`);
            return `✅ Status set: ${params.message}`;
        }

        case "reserve": {
            const mesh = context.mesh;
            if (!mesh) return "❌ Not connected to mesh. Use connect action or /channels command to connect.";
            if (!params.paths?.length) return "❌ Specify paths to reserve.";

            for (const value of params.paths) {
                const conflict = reservations.checkConflict(value, context.agentName, context.projectDir);
                if (conflict) {
                    return [
                        `❌ ${value}`,
                        `   Reserved by: ${conflict.agent}`,
                        `   Reason: "${conflict.reservation.reason}"`,
                        "",
                        `   Coordinate via pi_channels({ action: "send", to: "${conflict.agent}", message: "..." })`,
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
            const mesh = context.mesh;
            if (!mesh) return "❌ Not connected to mesh. Use connect action or /channels command to connect.";

            const entry = registry.getAgent(context.agentName);
            const { kept, released } = reservations.releaseReservations(entry?.reservations ?? [], params.paths);
            if (released.length === 0) return "No matching reservations to release.";

            registry.updateAgent(context.agentName, { reservations: kept });
            const releasedPaths = released.flatMap((reservation) => reservation.paths);
            mesh.send(`${context.agentName} released ${releasedPaths.join(", ")}`);
            return `✅ Released: ${releasedPaths.join(", ")}`;
        }

        case "spawn": {
            if (!params.prompt) return "❌ Specify a prompt for the new session.";

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
            return `❌ Unknown action: ${params.action}. Valid: ${ACTION_LIST}`;
    }
}
