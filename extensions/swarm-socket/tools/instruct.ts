/**
 * Swarm Instruct Tool
 *
 * Allows the queen/coordinator to send instructions to specific agents,
 * entire swarms, or broadcast to all agents via channels.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import type { Message } from "../../../../agent-channels/dist/index.js";
import { getSwarmState, getParentClients } from "../core/state.js";
import { getIdentity } from "../core/identity.js";
import { inboxName, GENERAL_CHANNEL, QUEEN_INBOX } from "../core/channels.js";

export function registerInstructTool(pi: ExtensionAPI): void {
    pi.registerTool({
        name: "swarm_instruct",
        label: "Swarm Instruct",
        description:
            "Send an instruction to a running swarm agent, a whole swarm, or all agents. " +
            "Use this to relay user instructions, adjust agent focus mid-task, or coordinate work. " +
            "If neither 'to' nor 'swarm' is specified, the instruction is broadcast to all agents.",
        parameters: Type.Object({
            instruction: Type.String({ description: "The instruction to send" }),
            to: Type.Optional(Type.String({ description: "Specific agent name to target" })),
            swarm: Type.Optional(Type.String({ description: "Target all agents in this swarm" })),
        }),
        async execute(_toolCallId, params) {
            const state = getSwarmState();
            if (!state) {
                return {
                    content: [{ type: "text", text: "No active swarm. Start a swarm first." }],
                    details: {},
                    isError: true,
                };
            }

            const identity = getIdentity();
            const msg: Message = {
                msg: params.instruction,
                data: {
                    type: "instruct",
                    from: identity.name,
                    instruction: params.instruction,
                    to: params.to,
                    swarm: params.swarm,
                },
            };

            // If we have queen clients (we're the queen/coordinator who started this swarm)
            if (state.queenClients.size > 0) {
                if (params.to) {
                    // Target a specific agent's inbox
                    const targetInbox = inboxName(params.to);
                    const client = state.queenClients.get(targetInbox);

                    if (client?.connected) {
                        try {
                            client.send(msg);
                            return {
                                content: [{ type: "text", text: `Instruction sent to ${params.to}: "${params.instruction}"` }],
                                details: { target: params.to },
                            };
                        } catch { /* fall through */ }
                    }

                    // Agent not found locally — try general broadcast
                    // (other coordinators may forward it)
                    const generalClient = state.queenClients.get(GENERAL_CHANNEL);
                    if (generalClient?.connected) {
                        try {
                            generalClient.send(msg);
                            return {
                                content: [{ type: "text", text: `Instruction broadcast (target "${params.to}" not found locally): "${params.instruction}"` }],
                                details: { target: params.to, broadcast: true },
                            };
                        } catch { /* fall through */ }
                    }

                    // Also try routing through parent channels (coordinator case)
                    const parentClients = getParentClients();
                    if (parentClients) {
                        const parentGeneral = parentClients.get(GENERAL_CHANNEL);
                        if (parentGeneral?.connected) {
                            try {
                                parentGeneral.send(msg);
                                return {
                                    content: [{ type: "text", text: `Instruction forwarded via parent channels to "${params.to}": "${params.instruction}"` }],
                                    details: { target: params.to, routed: true },
                                };
                            } catch { /* fall through */ }
                        }
                    }

                    return {
                        content: [{ type: "text", text: `No route to agent "${params.to}".` }],
                        details: {},
                        isError: true,
                    };
                } else if (params.swarm) {
                    // Target all agents in a specific swarm — send to general (they'll filter)
                    const generalClient = state.queenClients.get(GENERAL_CHANNEL);
                    if (generalClient?.connected) {
                        try {
                            generalClient.send(msg);
                        } catch { /* ignore */ }
                    }

                    // Count matching agents
                    const matchingAgents = Array.from(state.agents.values())
                        .filter(a => a.swarm === params.swarm);
                    return {
                        content: [{
                            type: "text",
                            text: `Instruction broadcast to swarm "${params.swarm}" (${matchingAgents.length} agents): "${params.instruction}"`,
                        }],
                        details: { swarm: params.swarm, agentCount: matchingAgents.length },
                    };
                } else {
                    // Broadcast to all — send to general channel
                    const generalClient = state.queenClients.get(GENERAL_CHANNEL);
                    if (generalClient?.connected) {
                        try {
                            generalClient.send(msg);
                        } catch { /* ignore */ }
                    }

                    return {
                        content: [{
                            type: "text",
                            text: `Instruction broadcast to all agents: "${params.instruction}"`,
                        }],
                        details: { target: "all" },
                    };
                }
            }

            // No queen clients — we're a coordinator without a local swarm
            // Route through parent channels
            const parentClients = getParentClients();
            if (parentClients) {
                const target = params.to ? inboxName(params.to) : GENERAL_CHANNEL;
                const client = parentClients.get(target) || parentClients.get(GENERAL_CHANNEL);
                if (client?.connected) {
                    try {
                        client.send(msg);
                        return {
                            content: [{
                                type: "text",
                                text: `Instruction relayed via parent channels: "${params.instruction}"`,
                            }],
                            details: { target: params.to || params.swarm || "all" },
                        };
                    } catch { /* fall through */ }
                }
            }

            return {
                content: [{ type: "text", text: "Not connected to any channels. Cannot send instruction." }],
                details: {},
                isError: true,
            };
        },

        renderCall(args, theme) {
            const target = args.to
                ? theme.fg("accent", args.to)
                : args.swarm
                    ? theme.fg("accent", `swarm:${args.swarm}`)
                    : theme.fg("accent", "all");
            const preview =
                args.instruction.length > 60
                    ? `${args.instruction.slice(0, 60)}...`
                    : args.instruction;
            return new Text(
                theme.fg("toolTitle", theme.bold("swarm_instruct ")) +
                    theme.fg("muted", "→ ") +
                    target +
                    "\n  " +
                    theme.fg("dim", preview),
                0,
                0,
            );
        },

        renderResult(result, _opts, theme) {
            const text = result.content[0];
            const content = text?.type === "text" ? text.text : "";
            const color = result.isError ? "error" : "success";
            return new Text(theme.fg(color, content), 0, 0);
        },
    });
}
