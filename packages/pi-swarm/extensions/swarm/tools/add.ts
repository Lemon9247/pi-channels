/**
 * Swarm Add Tool
 *
 * Dynamically adds agents to a running swarm. Creates inbox channels,
 * spawns processes, and wires lifecycle — same as the initial swarm
 * tool but mid-flight.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
    type AgentInfo,
    getSwarmState,
    getSwarmGeneration,
} from "../core/state.js";
import { getIdentity } from "../core/identity.js";
import {
    connectToChannel,
    GENERAL_CHANNEL,
    inboxName,
    topicName,
} from "../core/channels.js";
import { ChannelGroup } from "agent-channels";
import { spawnAgent } from "../core/spawn.js";
import { resolveCanSpawn } from "../core/agents.js";
import { scaffoldTaskDir } from "../core/scaffold.js";
import { updateDashboard } from "../ui/dashboard.js";
import {
    wireAgentProcess,
    setupQueenListener,
    type ToolContext,
} from "./swarm.js";

const SwarmAgentSchema = Type.Object({
    name: Type.String({ description: "Unique agent name (e.g. 'extra-scout')" }),
    role: Type.Literal("agent", {
        description: "Role in the swarm hierarchy",
    }),
    swarm: Type.String({ description: "Swarm this agent belongs to" }),
    task: Type.String({ description: "Task to delegate to this agent" }),
    agent: Type.Optional(Type.String({ description: "Name of a pre-defined agent to use" })),
    systemPrompt: Type.Optional(Type.String({ description: "Custom system prompt for inline agent" })),
    tools: Type.Optional(Type.Array(Type.String(), { description: "Tools for inline agent" })),
    model: Type.Optional(Type.String({ description: "Model for this agent" })),
    cwd: Type.Optional(Type.String({ description: "Working directory for this agent" })),
    canSpawn: Type.Optional(Type.Boolean({ description: "Grant this agent the ability to spawn sub-agents" })),
});

const AddParams = Type.Object({
    agents: Type.Array(SwarmAgentSchema, { description: "Agents to add to the running swarm" }),
});

export function registerAddTool(pi: ExtensionAPI): void {
    pi.registerTool({
        name: "swarm_add",
        label: "Swarm Add",
        description:
            "Add agents to a running swarm. Creates channels, spawns processes, " +
            "and wires them into the existing swarm. Use when you need more agents " +
            "mid-task — replacements, extra parallelism, or new directions.\n\n" +
            "Requires an active swarm (started with `swarm`). Agent names must be unique.",
        parameters: AddParams,

        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const state = getSwarmState();
            if (!state) {
                return {
                    content: [{ type: "text", text: "No active swarm. Use `swarm` to start one first." }],
                    details: {},
                    isError: true,
                };
            }

            // Validate no name collisions
            const collisions: string[] = [];
            for (const agentDef of params.agents) {
                if (state.agents.has(agentDef.name)) {
                    collisions.push(agentDef.name);
                }
            }
            if (collisions.length > 0) {
                return {
                    content: [{
                        type: "text",
                        text: `Name collision: ${collisions.join(", ")} already exist in the swarm.`,
                    }],
                    details: {},
                    isError: true,
                };
            }

            const gen = getSwarmGeneration();
            const spawnerName = getIdentity().name;
            const knownAgents = state.knownAgents;
            const defaultCwd = state.defaultCwd || ctx.cwd;
            const topicChannels = state.topicChannels || new Map<string, string>();
            const allAgentNames = [
                ...Array.from(state.agents.keys()),
                ...params.agents.map(a => a.name),
            ];

            // Reconnect to the existing group for dynamic channel addition
            let group: ChannelGroup;
            try {
                group = ChannelGroup.fromExisting(state.groupPath);
            } catch {
                return {
                    content: [{ type: "text", text: "Failed to reconnect to channel group." }],
                    details: {},
                    isError: true,
                };
            }

            const added: string[] = [];

            for (const agentDef of params.agents) {
                const inbox = inboxName(agentDef.name);

                // 1. Create inbox channel
                try {
                    await group.addChannel({ name: inbox });
                } catch (err) {
                    // Channel may already exist (e.g. from a previous failed add)
                    // Continue anyway — connectToChannel will fail if it's truly broken
                }

                // 2. Connect queen to new inbox
                let inboxClient;
                try {
                    inboxClient = await connectToChannel(state.groupPath, inbox);
                } catch (err) {
                    return {
                        content: [{
                            type: "text",
                            text: `Failed to connect to inbox for ${agentDef.name}: ${err}`,
                        }],
                        details: { added },
                        isError: true,
                    };
                }

                state.queenClients.set(inbox, inboxClient);
                setupQueenListener(inboxClient, inbox, gen, ctx as ToolContext, pi);

                // 3. Check if we need a new topic channel for a new swarm name
                let agentTopicChannel = topicChannels.get(agentDef.swarm);
                const swarmNames = new Set(
                    Array.from(state.agents.values()).map(a => a.swarm),
                );
                swarmNames.add(agentDef.swarm);
                if (swarmNames.size > 1 && !agentTopicChannel) {
                    // New swarm name — create topic channel
                    const topic = topicName(agentDef.swarm);
                    try {
                        await group.addChannel({ name: topic });
                        const topicClient = await connectToChannel(state.groupPath, topic);
                        state.queenClients.set(topic, topicClient);
                        setupQueenListener(topicClient, topic, gen, ctx as ToolContext, pi);
                        topicChannels.set(agentDef.swarm, topic);
                        agentTopicChannel = topic;
                    } catch {
                        // Non-fatal — agent will just use general channel
                    }
                }

                // 4. Register in SwarmState
                const agentInfo: AgentInfo = {
                    name: agentDef.name,
                    role: agentDef.role,
                    swarm: agentDef.swarm,
                    task: agentDef.task,
                    status: "starting",
                    agentType: agentDef.agent,
                    spawnedBy: getIdentity().role === "queen" ? undefined : spawnerName,
                };
                state.agents.set(agentDef.name, agentInfo);

                // 5. Scaffold agent file if task dir exists
                let agentFileInfo;
                if (state.taskDirPath) {
                    const scaffoldResult = scaffoldTaskDir(
                        state.taskDirPath,
                        undefined,
                        [agentInfo],
                    );
                    agentFileInfo = scaffoldResult?.agentFiles.get(agentDef.name);
                }

                // 6. Spawn the process
                const canSpawn = resolveCanSpawn(agentDef.canSpawn, agentDef.agent, knownAgents);
                const spawnDef = {
                    ...agentDef,
                    canSpawn,
                };
                const { process: proc, model } = spawnAgent(
                    spawnDef,
                    state.groupPath,
                    state.taskDirPath,
                    defaultCwd,
                    knownAgents,
                    agentFileInfo,
                    allAgentNames,
                    agentTopicChannel,
                );

                agentInfo.process = proc;
                agentInfo.model = model;

                // 7. Wire lifecycle
                wireAgentProcess(agentDef.name, proc, gen, ctx as ToolContext, pi);

                // 8. Announce on general channel
                const generalClient = state.queenClients.get(GENERAL_CHANNEL);
                if (generalClient?.connected) {
                    try {
                        generalClient.send({
                            msg: `New agent joined: ${agentDef.name}`,
                            data: {
                                type: "agent_added",
                                from: "system",
                                agent: agentDef.name,
                                task: agentDef.task,
                                swarm: agentDef.swarm,
                            },
                        });
                    } catch { /* best effort */ }
                }

                added.push(agentDef.name);
            }

            // Update dashboard
            updateDashboard(ctx);

            const agentList = params.agents
                .map((a) => `- **${a.name}** (${a.role}, swarm: ${a.swarm})`)
                .join("\n");

            return {
                content: [{
                    type: "text",
                    text: `Added ${added.length} agent(s) to running swarm:\n${agentList}`,
                }],
                details: { added },
            };
        },

        renderCall(args, theme) {
            const count = args.agents?.length || 0;
            let text =
                theme.fg("toolTitle", theme.bold("swarm_add ")) +
                theme.fg("accent", `${count} agent${count !== 1 ? "s" : ""}`);

            for (const a of (args.agents || []).slice(0, 4)) {
                const preview = a.task.length > 50 ? `${a.task.slice(0, 50)}...` : a.task;
                text += `\n  ${theme.fg("accent", a.name)} ${theme.fg("dim", preview)}`;
            }
            if (count > 4) {
                text += `\n  ${theme.fg("muted", `... +${count - 4} more`)}`;
            }

            return new Text(text, 0, 0);
        },

        renderResult(result, _opts, theme) {
            const text = result.content[0];
            const content = text?.type === "text" ? text.text : "(no output)";
            const color = result.isError ? "error" : "success";
            const icon = result.isError ? "✗" : "🐝";
            return new Text(`${icon} ${theme.fg(color, content)}`, 0, 0);
        },
    });
}
