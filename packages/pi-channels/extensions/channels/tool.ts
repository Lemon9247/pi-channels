import { type Mesh } from "agent-channels";
import { type ChannelsConfig, type ToolAction } from "./types.js";
import * as registry from "./registry.js";
import * as reservations from "./reservations.js";
import * as presence from "./presence.js";
import * as feed from "./feed.js";
import * as terminal from "./terminal.js";
import { generateUniqueName } from "./names.js";
import { loadConfig, saveConfigValue } from "./config.js";

/**
 * The pi_channels tool definition (for pi's tool registration).
 */
export const toolDefinition = {
    name: "pi_channels",
    description:
        "Communicate with other pi sessions. Actions: connect, join, leave, send, list, status, whois, channels, feed, reserve, release, spawn, set_status, rename, config.show, config.set",
    parameters: {
        type: "object" as const,
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
};

/**
 * Execute a pi_channels tool action.
 */
export async function executeTool(
    params: ToolAction,
    context: {
        mesh: Mesh | null;
        config: ChannelsConfig;
        agentName: string;
        projectDir: string;
        connectToMesh?: () => Promise<string>;
    },
): Promise<string> {
    const { mesh, config, agentName, projectDir } = context;

    switch (params.action) {
        // ─── Coordination ────────────────────────────────────────

        case "connect": {
            if (mesh) return `Already connected as ${agentName}.`;
            if (!context.connectToMesh) return "❌ Connect not available. Try reloading the extension.";
            return await context.connectToMesh();
        }

        case "join": {
            if (!mesh) {
                if (context.connectToMesh) {
                    const result = await context.connectToMesh();
                    // Re-read mesh from context after connecting — but since mesh is
                    // a module-level var in index.ts, we need to proceed with the
                    // channel join in the next call. Return connect result + hint.
                    return result + (params.channel ? `\nNow use join again to join #${params.channel}.` : "");
                }
                return "❌ Not connected to mesh. Use connect action first.";
            }

            if (params.channel) {
                await mesh.join(params.channel);

                // Announce channel creation on general
                mesh.send(`${agentName} joined #${params.channel}`, { channel: "general" });
                feed.appendEvent(projectDir, "join", agentName, `Joined #${params.channel}`);

                // Update registry
                registry.updateAgent(agentName, { channels: mesh.channels });

                return `✅ Joined #${params.channel} (members: ${mesh.channelMembers(params.channel).join(", ")})`;
            }

            return `Already in mesh. Channels: ${mesh.channels.join(", ")}`;
        }

        case "leave": {
            if (!mesh) return "❌ Not connected to mesh. Use connect action or /channels command to connect.";

            if (params.channel) {
                if (params.channel === "general") {
                    return "❌ Cannot leave #general.";
                }
                await mesh.leave(params.channel);
                feed.appendEvent(projectDir, "leave", agentName, `Left #${params.channel}`);
                registry.updateAgent(agentName, { channels: mesh.channels });
                return `✅ Left #${params.channel}`;
            }

            return "Specify a channel to leave, or use session shutdown to leave all.";
        }

        case "channels": {
            if (!mesh) return "❌ Not connected to mesh. Use connect action or /channels command to connect.";

            const lines = mesh.channels.map((ch) => {
                const members = mesh.channelMembers(ch);
                return `  #${ch} (${members.length} members: ${members.join(", ")})`;
            });
            return `📡 Channels:\n${lines.join("\n")}`;
        }

        case "list": {
            const agents = registry.listAgents();
            if (agents.length === 0) return "No agents registered.";

            const lines = agents.map((a) => {
                const emoji = presence.statusEmoji(a.status);
                const suffix = a.name === agentName ? " (you)" : "";
                const branch = a.branch ? ` on ${a.branch}` : "";
                return `  ${emoji} ${a.name}${suffix} — ${a.cwd}${branch}`;
            });
            return `👥 Agents:\n${lines.join("\n")}`;
        }

        case "status": {
            if (!mesh) return "❌ Not connected to mesh. Use connect action or /channels command to connect.";
            const myEntry = registry.getAgent(agentName);
            const peers = mesh.allMembers().filter((n) => n !== agentName);
            const resCount = myEntry?.reservations?.length ?? 0;
            return [
                `🐾 ${agentName} — ${mesh.channels.length} channels, ${peers.length} peers`,
                `   Channels: ${mesh.channels.map((c) => `#${c}`).join(", ")}`,
                `   Peers: ${peers.join(", ") || "none"}`,
                `   Reservations: ${resCount}`,
            ].join("\n");
        }

        case "whois": {
            if (!params.name) return "❌ Specify a name.";
            const agent = registry.getAgent(params.name);
            if (!agent) return `❌ Unknown agent: ${params.name}`;
            const emoji = presence.statusEmoji(agent.status);
            return [
                `${emoji} ${agent.name}`,
                `   CWD: ${agent.cwd}`,
                agent.branch ? `   Branch: ${agent.branch}` : null,
                agent.model ? `   Model: ${agent.model}` : null,
                `   Joined: ${agent.joinedAt}`,
                `   Last active: ${agent.lastActivity}`,
                `   Channels: ${agent.channels.join(", ")}`,
                agent.reservations.length > 0
                    ? `   Reservations: ${agent.reservations.map((r) => r.paths.join(", ")).join("; ")}`
                    : null,
                agent.spawnedBy ? `   Spawned by: ${agent.spawnedBy}` : null,
            ]
                .filter(Boolean)
                .join("\n");
        }

        case "feed": {
            const limit = params.limit ?? 20;
            const events = feed.readEvents(projectDir, limit);
            if (events.length === 0) return "No activity yet.";

            const lines = events.map((e) => {
                const time = new Date(e.timestamp).toLocaleTimeString();
                return `  [${time}] ${e.agent}: ${e.type}${e.detail ? ` — ${e.detail}` : ""}`;
            });
            return `📜 Activity Feed (last ${events.length}):\n${lines.join("\n")}`;
        }

        // ─── Messaging ──────────────────────────────────────────

        case "send": {
            if (!mesh) return "❌ Not connected to mesh. Use connect action or /channels command to connect.";
            if (!params.message) return "❌ Specify a message.";

            if (params.to) {
                // DM
                try {
                    await mesh.sendTo(params.to, params.message);
                    feed.appendEvent(projectDir, "message", agentName, `DM to ${params.to}: ${params.message}`);
                    return `✅ Sent DM to ${params.to}`;
                } catch (err) {
                    return `❌ ${(err as Error).message}`;
                }
            }

            // Channel message
            const channel = params.channel ?? "general";
            mesh.send(params.message, { channel });
            feed.appendEvent(projectDir, "message", agentName, `#${channel}: ${params.message}`);
            return `✅ Sent to #${channel}`;
        }

        case "set_status": {
            if (!mesh) return "❌ Not connected to mesh. Use connect action or /channels command to connect.";
            if (!params.message) return "❌ Specify a status message.";

            mesh.send(`📋 ${agentName}: ${params.message}`);
            return `✅ Status set: ${params.message}`;
        }

        // ─── Reservations ────────────────────────────────────────

        case "reserve": {
            if (!mesh) return "❌ Not connected to mesh. Use connect action or /channels command to connect.";
            if (!params.paths?.length) return "❌ Specify paths to reserve.";

            // Check for conflicts first
            for (const p of params.paths) {
                const conflict = reservations.checkConflict(p, agentName, projectDir);
                if (conflict) {
                    return [
                        `❌ ${p}`,
                        `   Reserved by: ${conflict.agent}`,
                        `   Reason: "${conflict.reservation.reason}"`,
                        ``,
                        `   Coordinate via pi_channels({ action: "send", to: "${conflict.agent}", message: "..." })`,
                    ].join("\n");
                }
            }

            const reason = params.reason ?? "Working on these files";
            const reservation = reservations.createReservation(agentName, params.paths, reason);

            // Broadcast to general
            mesh.send(`${agentName} reserved ${params.paths.join(", ")} — ${reason}`);

            // Update registry
            const myReservations = reservations.getReservations(agentName);
            registry.updateAgent(agentName, { reservations: myReservations });

            feed.appendEvent(projectDir, "reserve", agentName, params.paths.join(", "));
            return `✅ Reserved: ${params.paths.join(", ")} (${reason})`;
        }

        case "release": {
            if (!mesh) return "❌ Not connected to mesh. Use connect action or /channels command to connect.";

            const released = reservations.releaseReservation(agentName, params.paths);
            if (released.length === 0) return "No matching reservations to release.";

            const releasedPaths = released.flatMap((r) => r.paths);

            // Broadcast release
            mesh.send(`${agentName} released ${releasedPaths.join(", ")}`);

            // Update registry
            const myReservations = reservations.getReservations(agentName);
            registry.updateAgent(agentName, { reservations: myReservations });

            feed.appendEvent(projectDir, "release", agentName, releasedPaths.join(", "));
            return `✅ Released: ${releasedPaths.join(", ")}`;
        }

        // ─── Spawn ──────────────────────────────────────────────

        case "spawn": {
            if (!params.prompt) return "❌ Specify a prompt for the new session.";

            const newName = generateUniqueName(config.nameTheme, registry.registeredNames(), config.nameWords);

            const env: Record<string, string> = {
                PI_CHANNELS_AUTO_JOIN: "1",
                PI_CHANNELS_SPAWNED_BY: agentName,
                PI_AGENT_NAME: newName,
            };
            if (params.channels?.length) {
                env.PI_CHANNELS_JOIN = params.channels.join(",");
            }

            const result = terminal.spawnTerminal({
                prompt: params.prompt,
                cwd: params.cwd,
                terminal: config.terminal,
                env,
            });

            feed.appendEvent(projectDir, "spawn", agentName, `Spawned ${newName}`);

            if (result.success) {
                return `✅ Spawned ${newName} in ${result.terminal} terminal\n   Prompt: "${params.prompt}"`;
            } else {
                return [
                    `⚠️ Could not auto-open terminal. Run this command manually:`,
                    ``,
                    `   ${result.command}`,
                    ``,
                    `   (Agent name: ${newName})`,
                ].join("\n");
            }
        }

        // ─── Config ─────────────────────────────────────────────

        case "rename": {
            if (!params.name) return "❌ Specify a new name.";
            const existing = registry.registeredNames();
            if (existing.has(params.name)) return `❌ Name "${params.name}" is already taken.`;

            // Re-register with new name
            const entry = registry.getAgent(agentName);
            if (entry) {
                registry.unregisterAgent(agentName);
                entry.name = params.name;
                registry.registerAgent(entry);
            }

            return `✅ Renamed to ${params.name}`;
        }

        case "config.show": {
            const lines = Object.entries(config).map(
                ([k, v]) => `  ${k}: ${JSON.stringify(v)}`,
            );
            return `⚙️ Config:\n${lines.join("\n")}`;
        }

        case "config.set": {
            if (!params.key) return "❌ Specify a config key.";
            if (params.value === undefined) return "❌ Specify a value.";

            saveConfigValue(params.key, params.value, projectDir);
            return `✅ Set ${params.key} = ${JSON.stringify(params.value)}`;
        }

        default:
            return `❌ Unknown action: ${params.action}. Valid: connect, join, leave, send, list, status, whois, channels, feed, reserve, release, spawn, set_status, rename, config.show, config.set`;
    }
}
