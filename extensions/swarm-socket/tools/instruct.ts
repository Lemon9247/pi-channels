/**
 * Swarm Instruct Tool
 *
 * Allows the queen/coordinator to send instructions to specific agents,
 * entire swarms, or broadcast to all agents.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { getSwarmState, getParentClient } from "../core/state.js";
import { getIdentity } from "../core/identity.js";
import { serialize } from "../transport/protocol.js";
import type { SenderInfo } from "../core/router.js";

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

            if (!state.server) {
                // Coordinator without a local server — route through parent socket
                const parentClient = getParentClient();
                if (!parentClient || !parentClient.connected) {
                    return {
                        content: [{ type: "text", text: "Not connected to parent socket. Cannot route instruction." }],
                        details: {},
                        isError: true,
                    };
                }
                parentClient.instruct(params.instruction, params.to, params.swarm);
                return {
                    content: [{ type: "text", text: `Instruction relayed via parent socket: "${params.instruction}"` }],
                    details: { target: params.to || params.swarm || "all" },
                };
            }

            // We own the server — send instruct through it
            const server = state.server;
            const clients = server.getClients();

            // Build the instruct message
            const msg = {
                type: "instruct" as const,
                instruction: params.instruction,
                to: params.to,
                swarm: params.swarm,
            };

            // Use identity for sender info instead of hardcoded "queen"
            const identity = getIdentity();
            const sender: SenderInfo = {
                name: identity.name,
                role: identity.role,
                swarm: identity.swarm,
            };

            let recipients = server.getRecipients(sender, msg);

            // If targeting a specific agent that's not on this socket,
            // forward to all coordinators — they'll check their own agents
            if (recipients.length === 0 && params.to) {
                const coordinators = Array.from(clients.values()).filter(c => c.role === "coordinator");
                if (coordinators.length > 0) {
                    recipients = coordinators;
                }
            }

            if (recipients.length === 0) {
                // Parent-socket fallback: if we're a coordinator with a local server
                // but the target isn't here, route through the parent socket to reach peers
                const parentClient = getParentClient();
                if (parentClient && parentClient.connected) {
                    parentClient.instruct(params.instruction, params.to, params.swarm);
                    return {
                        content: [{ type: "text", text: `Instruction forwarded via parent socket to "${params.to || params.swarm || "all"}" (delivery not confirmed — async routing)` }],
                        details: { target: params.to || params.swarm || "all", routed: true },
                    };
                }

                const target = params.to || params.swarm || "all";
                return {
                    content: [{ type: "text", text: `No agents found for target "${target}".` }],
                    details: {},
                    isError: true,
                };
            }

            // Send to each recipient
            const relayed = {
                from: { name: identity.name, role: identity.role, swarm: identity.swarm },
                message: msg,
            };
            const data = serialize(relayed);

            for (const recipient of recipients) {
                try {
                    if (recipient.transport.connected) {
                        recipient.transport.write(data);
                    }
                } catch {
                    // Transport may have closed
                }
            }

            const names = recipients.map((r) => r.name).join(", ");
            const forwarded = recipients.some(r => r.role === "coordinator") && params.to;
            return {
                content: [
                    {
                        type: "text",
                        text: forwarded
                            ? `Instruction forwarded via coordinator(s) to "${params.to}": ${names}\n"${params.instruction}"`
                            : `Instruction sent to ${recipients.length} agent(s): ${names}\n"${params.instruction}"`,
                    },
                ],
                details: { recipients: names },
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
