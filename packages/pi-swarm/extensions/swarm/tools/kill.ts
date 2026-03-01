/**
 * Swarm Kill Tool
 *
 * Terminates a specific agent by name. Sends SIGTERM, marks as disconnected,
 * removes inbox channel, and recursively kills any sub-agents spawned by
 * the target (tracked via spawnedBy in AgentInfo).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { ChannelGroup } from "agent-channels";
import {
    getSwarmState,
    updateAgentStatus,
    type AgentInfo,
} from "../core/state.js";
import { inboxName } from "../core/channels.js";

/**
 * Kill a single agent: SIGTERM the process, mark disconnected, remove inbox.
 */
async function killAgent(
    agent: AgentInfo,
    groupPath: string | undefined,
    reason?: string,
): Promise<void> {
    // Send SIGTERM to the process group (kills agent + any children)
    if (agent.process && !agent.process.killed && agent.process.pid) {
        try {
            process.kill(-agent.process.pid, "SIGTERM");
        } catch {
            try { agent.process.kill("SIGTERM"); } catch { /* ignore */ }
        }
    }

    // Mark as disconnected
    updateAgentStatus(agent.name, "disconnected");
    if (reason) {
        agent.blockerDescription = `Killed: ${reason}`;
    }

    // Remove inbox channel from the group
    if (groupPath) {
        try {
            const group = ChannelGroup.fromExisting(groupPath);
            await group.removeChannel(inboxName(agent.name));
        } catch { /* ignore — channel may already be gone */ }
    }
}

/**
 * Recursively kill an agent and all its sub-agents.
 * Sub-agents are identified via the spawnedBy field on AgentInfo.
 */
async function killRecursive(
    targetName: string,
    agents: Map<string, AgentInfo>,
    groupPath: string | undefined,
    reason?: string,
): Promise<string[]> {
    const killed: string[] = [];

    // Find and kill sub-agents first (depth-first)
    const subAgents = Array.from(agents.values()).filter(
        (a) => a.spawnedBy === targetName,
    );
    for (const sub of subAgents) {
        const subKilled = await killRecursive(sub.name, agents, groupPath, "parent killed");
        killed.push(...subKilled);
    }

    // Kill the target
    const target = agents.get(targetName);
    if (target && target.status !== "done" && target.status !== "disconnected" && target.status !== "crashed") {
        await killAgent(target, groupPath, reason);
        killed.push(targetName);
    }

    return killed;
}

export function registerKillTool(pi: ExtensionAPI): void {
    pi.registerTool({
        name: "swarm_kill",
        label: "Swarm Kill",
        description:
            "Kill a specific agent by name. Sends SIGTERM, marks as disconnected, " +
            "removes inbox channel, and recursively kills any sub-agents spawned by the target.",
        parameters: Type.Object({
            name: Type.String({ description: "Name of the agent to kill" }),
            reason: Type.Optional(Type.String({ description: "Optional reason for killing the agent" })),
        }),
        async execute(_toolCallId, params) {
            const state = getSwarmState();
            if (!state) {
                return {
                    content: [{ type: "text", text: "No active swarm." }],
                    details: {},
                    isError: true,
                };
            }

            const agent = state.agents.get(params.name);
            if (!agent) {
                return {
                    content: [{ type: "text", text: `Agent "${params.name}" not found in swarm.` }],
                    details: {},
                    isError: true,
                };
            }

            const killed = await killRecursive(
                params.name,
                state.agents,
                state.groupPath,
                params.reason,
            );

            const killedList = killed.join(", ") || "(none — already terminated)";
            return {
                content: [{
                    type: "text",
                    text: `Killed: ${killedList}` +
                        (params.reason ? ` (reason: ${params.reason})` : ""),
                }],
                details: { killed, reason: params.reason },
            };
        },

        renderCall(args, theme) {
            let text = theme.fg("toolTitle", theme.bold("swarm_kill ")) +
                theme.fg("error", args.name || "...");
            if (args.reason) {
                text += theme.fg("dim", ` (${args.reason})`);
            }
            return new Text(text, 0, 0);
        },

        renderResult(result, _opts, theme) {
            const text = result.content[0];
            const content = text?.type === "text" ? text.text : "";
            const color = result.isError ? "error" : "warning";
            return new Text(theme.fg(color, content), 0, 0);
        },
    });
}
