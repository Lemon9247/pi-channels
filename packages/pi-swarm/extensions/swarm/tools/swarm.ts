/**
 * Swarm Tool
 *
 * Non-blocking tool that spawns agents as background processes.
 * Returns immediately — results flow back via channel notifications.
 *
 * Creates a ChannelGroup with general + per-agent inbox channels.
 * Queen monitors all channels for status updates.
 */

import * as crypto from "node:crypto";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text, Container, Spacer, Markdown } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import type { Message } from "agent-channels";
import {
    createSwarmChannelGroup,
    connectToMultiple,
    GENERAL_CHANNEL,
    QUEEN_INBOX,
    inboxName,
    topicName,
} from "../core/channels.js";
import {
    type AgentInfo,
    type SwarmState,
    getSwarmState,
    getSwarmGeneration,
    setSwarmState,
    updateAgentStatus,
    cleanupSwarm,
    getParentClients,
} from "../core/state.js";
import { getIdentity } from "../core/identity.js";
import { scaffoldTaskDir, scaffoldCoordinatorSubDir, type ScaffoldResult } from "../core/scaffold.js";
import { spawnAgent, spawnAgentBlocking, type AgentDef, type SingleResult } from "../core/spawn.js";
import { discoverAgents, type AgentConfig, type AgentScope } from "../core/agents.js";
import { updateDashboard } from "../ui/dashboard.js";
import { isDashboardOpen } from "../ui/overlay.js";
import {
    trackAgentOutput, clearActivity, pushSyntheticEvent, getAgentActivity,
    feedRawEvent,
} from "../ui/activity.js";
import {
    formatToolCall, formatUsageStats, getFinalOutput, getDisplayItems,
    type UsageStats,
} from "../ui/format.js";

// Agent definition for async swarm mode — requires role and swarm assignment
const SwarmAgentSchema = Type.Object({
    name: Type.String({ description: "Unique agent name (e.g. 'agent a1')" }),
    role: Type.Union([Type.Literal("coordinator"), Type.Literal("agent")], {
        description: "Role in the swarm hierarchy",
    }),
    swarm: Type.String({ description: "Swarm this agent belongs to" }),
    task: Type.String({ description: "Task to delegate to this agent" }),
    agent: Type.Optional(Type.String({ description: "Name of a pre-defined agent to use" })),
    systemPrompt: Type.Optional(Type.String({ description: "Custom system prompt for inline agent" })),
    tools: Type.Optional(Type.Array(Type.String(), { description: "Tools for inline agent" })),
    model: Type.Optional(Type.String({ description: "Model for this agent" })),
    cwd: Type.Optional(Type.String({ description: "Working directory for this agent" })),
});

// Chain step definition — for sequential blocking execution
const ChainStepSchema = Type.Object({
    agent: Type.String({ description: "Name of a pre-defined agent to use" }),
    task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
    cwd: Type.Optional(Type.String({ description: "Working directory for this step" })),
});

const TaskDirDef = Type.Object({
    path: Type.String({ description: "Path to the task directory for swarm coordination files" }),
    overview: Type.Optional(Type.String({ description: "Task overview for the coordination template" })),
});

const SwarmParams = Type.Object({
    agents: Type.Array(SwarmAgentSchema, { description: "Agents to spawn in the swarm" }),
    taskDir: Type.Optional(TaskDirDef),
    blocking: Type.Optional(Type.Boolean({
        description: "Override auto-detection: true = wait for completion, false = async with channels. " +
            "Default: 1 agent → blocking, 2+ agents → async, chain → always blocking.",
    })),
    chain: Type.Optional(Type.Array(ChainStepSchema, {
        description: "Chain mode: sequential blocking spawns. Each step's task can use {previous} " +
            "for the prior agent's output. Chain mode is always blocking.",
    })),
    agentScope: Type.Optional(Type.Union(
        [Type.Literal("user"), Type.Literal("project"), Type.Literal("both")],
        { description: "Agent discovery scope. Default: 'user'." },
    )),
    confirmProjectAgents: Type.Optional(Type.Boolean({
        description: "Show confirmation dialog when agentScope includes project agents. Default: true.",
    })),
});

function generateSwarmId(): string {
    return crypto.randomBytes(4).toString("hex");
}

// ─── Blocking Mode Helpers ───────────────────────────────────────────

/** Determine if this invocation should use blocking mode. */
export function shouldBlock(params: {
    blocking?: boolean;
    chain?: unknown[];
    agents: unknown[];
    taskDir?: unknown;
}): boolean {
    // Explicit override
    if (params.blocking !== undefined) return params.blocking;
    // Chain mode is always blocking
    if (params.chain && params.chain.length > 0) return true;
    // 1 agent without taskDir → blocking (single-agent mode)
    if (params.agents.length === 1 && !params.taskDir) return true;
    // 2+ agents → async (swarm-style)
    return false;
}

/** Run async functions with a concurrency limit. */
export async function mapWithConcurrencyLimit<T, R>(
    items: T[],
    limit: number,
    fn: (item: T) => Promise<R>,
): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let index = 0;

    async function worker(): Promise<void> {
        while (index < items.length) {
            const i = index++;
            results[i] = await fn(items[i]);
        }
    }

    const workers = Array.from(
        { length: Math.min(limit, items.length) },
        () => worker(),
    );
    await Promise.all(workers);
    return results;
}

/** Merge usage stats from multiple results. */
export function aggregateUsage(results: SingleResult[]): UsageStats {
    const totals: UsageStats = {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0,
    };
    for (const r of results) {
        totals.input += r.usage.input;
        totals.output += r.usage.output;
        totals.cacheRead += r.usage.cacheRead;
        totals.cacheWrite += r.usage.cacheWrite;
        totals.cost += r.usage.cost;
        totals.turns = (totals.turns ?? 0) + (r.usage.turns ?? 0);
    }
    return totals;
}

/** Format a SingleResult into text for the tool response content. */
export function formatBlockingResult(results: SingleResult[], mode: "single" | "parallel" | "chain"): string {
    if (mode === "single") {
        const r = results[0];
        const output = getFinalOutput(r.messages);
        if (r.exitCode !== 0) {
            return `Agent **${r.agent}** failed (exit code ${r.exitCode}).\n` +
                (r.errorMessage ? `Error: ${r.errorMessage}\n` : "") +
                (output ? `\nLast output:\n${output}` : "");
        }
        return output || "(no output)";
    }

    const lines: string[] = [];
    const succeeded = results.filter(r => r.exitCode === 0);
    const failed = results.filter(r => r.exitCode !== 0);

    if (mode === "chain") {
        lines.push(`Chain completed: ${succeeded.length}/${results.length} steps succeeded.\n`);
        for (const r of results) {
            const icon = r.exitCode === 0 ? "✓" : "✗";
            const output = getFinalOutput(r.messages);
            const preview = output.length > 200 ? output.slice(0, 200) + "..." : output;
            lines.push(`**Step ${r.step}** (${r.agent}): ${icon}`);
            if (preview) lines.push(preview);
            lines.push("");
        }
    } else {
        lines.push(`Parallel execution: ${succeeded.length}/${results.length} succeeded.\n`);
        for (const r of results) {
            const icon = r.exitCode === 0 ? "✓" : "✗";
            const output = getFinalOutput(r.messages);
            const preview = output.length > 200 ? output.slice(0, 200) + "..." : output;
            lines.push(`**${r.agent}**: ${icon}`);
            if (r.exitCode !== 0 && r.errorMessage) lines.push(`  Error: ${r.errorMessage}`);
            if (preview) lines.push(preview);
            lines.push("");
        }
    }

    return lines.join("\n");
}

// ─── Blocking Execution ──────────────────────────────────────────────

const BLOCKING_CONCURRENCY_LIMIT = 4;

/** Execute one or more agents in blocking mode (no channels). */
async function executeBlocking(
    agents: Array<{ name: string; task: string; agent?: string; model?: string; cwd?: string }>,
    defaultCwd: string,
    knownAgents: Map<string, AgentConfig>,
    signal: AbortSignal | undefined,
    onUpdate: ((partialResult: any) => void) | undefined,
): Promise<{ results: SingleResult[]; mode: "single" | "parallel" }> {
    const mode = agents.length === 1 ? "single" : "parallel";

    // Accumulator for parallel streaming updates — shows all completed + current partial
    const completedResults: SingleResult[] = [];

    const runOne = async (agentSpec: typeof agents[0]): Promise<SingleResult> => {
        const def: AgentDef = {
            name: agentSpec.name,
            task: agentSpec.task,
            agent: agentSpec.agent,
            model: agentSpec.model,
            cwd: agentSpec.cwd,
        };

        const result = await spawnAgentBlocking(
            def,
            defaultCwd,
            knownAgents,
            signal,
            (partialResult) => {
                // Streaming update: emit partial tool result
                if (onUpdate) {
                    const allResults = mode === "single"
                        ? [partialResult]
                        : [...completedResults, partialResult];
                    const text = formatBlockingResult(allResults, mode);
                    onUpdate({
                        content: [{ type: "text", text }],
                        details: {
                            mode: "blocking",
                            blockingMode: mode,
                            results: allResults,
                        },
                    });
                }
            },
            undefined,  // step
            (line) => feedRawEvent(agentSpec.name, line),  // onRawLine → activity store
        );

        completedResults.push(result);
        return result;
    };

    let results: SingleResult[];
    if (agents.length === 1) {
        results = [await runOne(agents[0])];
    } else {
        // Parallel blocking with concurrency limit — continue on failure
        results = await mapWithConcurrencyLimit(
            agents,
            BLOCKING_CONCURRENCY_LIMIT,
            (agent) => runOne(agent).catch((err): SingleResult => ({
                agent: agent.agent || agent.name,
                agentSource: "unknown",
                task: agent.task,
                exitCode: 1,
                messages: [],
                stderr: "",
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
                errorMessage: err?.message || String(err),
            })),
        );
    }

    return { results, mode };
}

/** Execute a chain of agents sequentially in blocking mode. */
async function executeChain(
    chain: Array<{ agent: string; task: string; cwd?: string }>,
    defaultCwd: string,
    knownAgents: Map<string, AgentConfig>,
    signal: AbortSignal | undefined,
    onUpdate: ((partialResult: any) => void) | undefined,
): Promise<{ results: SingleResult[] }> {
    // Validate all agent names before starting
    for (const step of chain) {
        if (step.agent && !knownAgents.has(step.agent)) {
            const available = [...knownAgents.keys()].join(", ");
            throw new Error(
                `Chain step references unknown agent "${step.agent}". Available agents: ${available || "(none)"}`,
            );
        }
    }

    const results: SingleResult[] = [];
    let previousOutput = "";

    for (let i = 0; i < chain.length; i++) {
        const step = chain[i];
        // Substitute {previous} with prior output
        const task = step.task.replace(/\{previous\}/g, previousOutput);
        const name = `${step.agent}-step${i + 1}`;

        const def: AgentDef = {
            name,
            task,
            agent: step.agent,
            cwd: step.cwd,
        };

        const result = await spawnAgentBlocking(
            def,
            defaultCwd,
            knownAgents,
            signal,
            (partialResult) => {
                if (onUpdate) {
                    onUpdate({
                        content: [{
                            type: "text",
                            text: formatBlockingResult([...results, partialResult], "chain"),
                        }],
                        details: {
                            mode: "blocking",
                            blockingMode: "chain",
                            results: [...results, partialResult],
                            step: i + 1,
                            totalSteps: chain.length,
                        },
                    });
                }
            },
            i + 1,  // step number
            (line) => feedRawEvent(name, line),
        );

        results.push(result);

        // Stop on first error
        if (result.exitCode !== 0) {
            break;
        }

        previousOutput = getFinalOutput(result.messages);
    }

    return { results };
}

// ─── Render Helpers ──────────────────────────────────────────────────

/** Render collapsed view of a blocking single result. */
function renderBlockingSingle(result: SingleResult, theme: any): Text {
    const icon = result.exitCode === 0 ? "✓" : "✗";
    const color = result.exitCode === 0 ? "success" : "error";
    const items = getDisplayItems(result.messages);
    const toolCalls = items.filter(i => i.type === "toolCall");
    const lastCalls = toolCalls.slice(-5);

    const lines: string[] = [];
    lines.push(`${icon} ${theme.fg(color, result.agent)} ${theme.fg("dim", formatUsageStats(result.usage, result.model))}`);

    if (lastCalls.length > 0) {
        for (const call of lastCalls) {
            if (call.type === "toolCall") {
                lines.push(`  ${formatToolCall(call.name, call.args, theme.fg.bind(theme))}`);
            }
        }
        if (toolCalls.length > lastCalls.length) {
            lines.push(`  ${theme.fg("muted", `... +${toolCalls.length - lastCalls.length} more`)}`);
        }
    }

    const output = getFinalOutput(result.messages);
    if (output) {
        const preview = output.length > 120 ? output.slice(0, 120) + "..." : output;
        lines.push(`  ${theme.fg("dim", preview)}`);
    }

    return new Text(lines.join("\n"), 0, 0);
}

/** Render expanded view of a blocking single result. */
function renderBlockingSingleExpanded(result: SingleResult, theme: any): Container {
    const container = new Container();
    const icon = result.exitCode === 0 ? "✓" : "✗";
    const color = result.exitCode === 0 ? "success" : "error";

    // Header
    container.addChild(new Text(
        `${icon} ${theme.fg(color, result.agent)} ${theme.fg("dim", formatUsageStats(result.usage, result.model))}`,
        0, 0,
    ));

    // Task
    container.addChild(new Text(theme.fg("dim", `Task: ${result.task}`), 1, 0));
    container.addChild(new Spacer(1));

    // All tool calls
    const items = getDisplayItems(result.messages);
    const toolCalls = items.filter(i => i.type === "toolCall");
    if (toolCalls.length > 0) {
        const callLines = toolCalls.map(call => {
            if (call.type === "toolCall") {
                return `  ${formatToolCall(call.name, call.args, theme.fg.bind(theme))}`;
            }
            return "";
        }).join("\n");
        container.addChild(new Text(callLines, 0, 0));
        container.addChild(new Spacer(1));
    }

    // Full output as Markdown
    const output = getFinalOutput(result.messages);
    if (output) {
        container.addChild(new Markdown(output));
    }

    return container;
}

/** Render blocking multi-agent result (collapsed). */
function renderBlockingMulti(results: SingleResult[], theme: any): Text {
    const succeeded = results.filter(r => r.exitCode === 0).length;
    const total = results.length;
    const allOk = succeeded === total;
    const icon = allOk ? "✓" : "⚠";
    const color = allOk ? "success" : "warning";

    const usage = aggregateUsage(results);
    const lines: string[] = [];
    lines.push(`${icon} ${theme.fg(color, `${succeeded}/${total} agents`)} ${theme.fg("dim", formatUsageStats(usage))}`);

    for (const r of results) {
        const rIcon = r.exitCode === 0 ? "✓" : "✗";
        const rColor = r.exitCode === 0 ? "success" : "error";
        const output = getFinalOutput(r.messages);
        const preview = output.length > 80 ? output.slice(0, 80) + "..." : output;
        lines.push(`  ${rIcon} ${theme.fg(rColor, r.agent)} ${theme.fg("dim", preview || "(no output)")}`);
    }

    return new Text(lines.join("\n"), 0, 0);
}

/** Render chain result (collapsed). */
function renderChainResult(results: SingleResult[], theme: any): Text {
    const succeeded = results.filter(r => r.exitCode === 0).length;
    const total = results.length;
    const allOk = succeeded === total;
    const icon = allOk ? "✓" : "⚠";
    const color = allOk ? "success" : "warning";

    const usage = aggregateUsage(results);
    const lines: string[] = [];
    lines.push(`${icon} ${theme.fg(color, `chain ${succeeded}/${total} steps`)} ${theme.fg("dim", formatUsageStats(usage))}`);

    for (const r of results) {
        const rIcon = r.exitCode === 0 ? "✓" : "✗";
        const rColor = r.exitCode === 0 ? "success" : "error";
        const output = getFinalOutput(r.messages);
        const preview = output.length > 80 ? output.slice(0, 80) + "..." : output;
        lines.push(`  ${rIcon} ${theme.fg(rColor, `Step ${r.step} (${r.agent})`)} ${theme.fg("dim", preview || "(no output)")}`);
    }

    return new Text(lines.join("\n"), 0, 0);
}

/** Render expanded view for multi-agent/chain results. */
function renderBlockingMultiExpanded(results: SingleResult[], mode: "parallel" | "chain", theme: any): Container {
    const container = new Container();
    const succeeded = results.filter(r => r.exitCode === 0).length;
    const total = results.length;
    const usage = aggregateUsage(results);
    const label = mode === "chain" ? "chain" : "parallel";

    container.addChild(new Text(
        `${label}: ${succeeded}/${total} succeeded ${theme.fg("dim", formatUsageStats(usage))}`,
        0, 0,
    ));
    container.addChild(new Spacer(1));

    for (const r of results) {
        container.addChild(renderBlockingSingleExpanded(r, theme));
        container.addChild(new Spacer(1));
    }

    return container;
}

/** Minimal structural type for the tool execution context from pi. */
interface ToolContext {
    cwd: string;
    hasUI: boolean;
    ui: {
        setWidget(id: string, widget: unknown): void;
        setStatus(id: string, status: unknown): void;
        notify(msg: string, level: string): void;
    };
}

/**
 * Relay an event up to the parent swarm (coordinator → queen).
 * No-op if we're not a coordinator (no parent clients).
 */
function relayToParent(
    event: string,
    name: string,
    agent: AgentInfo | undefined,
    extra?: Record<string, unknown>,
): void {
    const clients = getParentClients();
    if (!clients) return;
    const queenClient = clients.get(QUEEN_INBOX);
    if (!queenClient?.connected) return;
    try {
        queenClient.send({
            msg: `relay: ${event}`,
            data: {
                type: "relay",
                relay: {
                    event,
                    name,
                    role: agent?.role || "agent",
                    swarm: agent?.swarm || "unknown",
                    ...extra,
                },
            },
        });
    } catch { /* ignore */ }
}

/**
 * Handle a relay event that a coordinator forwarded from a sub-agent.
 * Adds/updates the sub-agent in the queen's state for the dashboard.
 */
function handleRelayEvent(
    state: SwarmState,
    relay: Record<string, unknown>,
    ctx: ToolContext,
): void {
    const name = relay.name as string;
    const event = relay.event as string;
    const role = (relay.role as string) || "agent";
    const swarm = (relay.swarm as string) || "unknown";
    const existing = state.agents.get(name);

    if (event === "register") {
        if (!existing) {
            state.agents.set(name, {
                name,
                role: role as "coordinator" | "agent",
                swarm,
                task: "(sub-agent)",
                status: "running",
            });
        }
        pushSyntheticEvent(name, "message", `registered (${role}, ${swarm})`);
    } else if (event === "done") {
        const summary = relay.summary as string | undefined;
        if (existing) {
            updateAgentStatus(name, "done", { doneSummary: summary });
        } else {
            state.agents.set(name, {
                name,
                role: role as "coordinator" | "agent",
                swarm,
                task: "(sub-agent)",
                status: "done",
                doneSummary: summary,
            });
        }
        pushSyntheticEvent(name, "tool_end", `✓ done: ${summary || "completed"}`);
    } else if (event === "blocked") {
        const description = relay.description as string | undefined;
        if (existing) {
            updateAgentStatus(name, "blocked", { blockerDescription: description });
        } else {
            state.agents.set(name, {
                name,
                role: role as "coordinator" | "agent",
                swarm,
                task: "(sub-agent)",
                status: "blocked",
                blockerDescription: description,
            });
        }
        pushSyntheticEvent(name, "tool_end", `⚠ blocked: ${description || "unknown"}`);
    } else if (event === "disconnected") {
        if (existing) {
            updateAgentStatus(name, "disconnected");
        }
        pushSyntheticEvent(name, "message", "disconnected");
    } else if (event === "nudge") {
        pushSyntheticEvent(name, "message", `hive-mind: ${relay.reason || ""}`);
    }

    updateDashboard(ctx);

    // Passthrough: if we have parent channels, forward the relay up
    const parentClients = getParentClients();
    if (parentClients) {
        const queenInbox = parentClients.get(QUEEN_INBOX);
        if (queenInbox?.connected) {
            try {
                queenInbox.send({ msg: `relay: ${name} ${event}`, data: { type: "relay", relay } });
            } catch { /* ignore */ }
        }
    }
}

/**
 * Handle an incoming channel message from the queen's perspective.
 * Parses data.type to dispatch to appropriate handler.
 */
function handleQueenMessage(
    state: SwarmState,
    gen: number,
    msg: Message,
    fromChannel: string,
    agentMap: Map<string, AgentInfo>,
    ctx: ToolContext,
    pi: ExtensionAPI,
): void {
    if (getSwarmGeneration() !== gen) return;
    if (!msg.data || !msg.data.type) return;

    const type = msg.data.type as string;
    const senderName = (msg.data.from as string) || "unknown";

    // Dedup: messages sent to both QUEEN_INBOX and GENERAL (defense-in-depth)
    // are only processed from QUEEN_INBOX. General is the fallback channel —
    // if the queen got it on QUEEN_INBOX, ignore the duplicate on general.
    const primaryOnQueenInbox = ["done", "blocker", "progress", "register"];
    if (primaryOnQueenInbox.includes(type) && fromChannel === GENERAL_CHANNEL) {
        return;
    }

    switch (type) {
        case "register": {
            if (updateAgentStatus(senderName, "running")) {
                pushSyntheticEvent(senderName, "message", `registered (${msg.data.role || "agent"})`);
                updateDashboard(ctx);
            }
            break;
        }

        case "done": {
            const summary = (msg.data.summary as string) || "";
            if (updateAgentStatus(senderName, "done", { doneSummary: summary })) {
                state.onAgentDone?.(senderName, summary);
                updateDashboard(ctx);
                relayToParent("done", senderName, agentMap.get(senderName), { summary });
            }
            break;
        }

        case "blocker": {
            const description = (msg.data.description as string) || "";
            if (updateAgentStatus(senderName, "blocked", { blockerDescription: description })) {
                state.onBlocker?.(senderName, description);
                updateDashboard(ctx);
                relayToParent("blocked", senderName, agentMap.get(senderName), { description });
            }
            break;
        }

        case "nudge": {
            const reason = (msg.data.reason as string) || msg.msg;
            state.onNudge?.(reason, senderName);
            relayToParent("nudge", senderName, agentMap.get(senderName), { reason });
            break;
        }

        case "progress": {
            const agent = state.agents.get(senderName);
            if (agent) {
                if (msg.data.phase != null) agent.progressPhase = msg.data.phase as string;
                if (msg.data.percent != null) agent.progressPercent = msg.data.percent as number;
                if (msg.data.detail != null) agent.progressDetail = msg.data.detail as string;
            }
            const detail = (msg.data.detail as string) || (msg.data.phase as string) || "progress";
            const pct = msg.data.percent != null ? ` (${msg.data.percent}%)` : "";
            pushSyntheticEvent(senderName, "message", `${detail}${pct}`);
            updateDashboard(ctx);
            break;
        }

        case "relay": {
            const relay = msg.data.relay as Record<string, unknown>;
            if (relay) {
                handleRelayEvent(state, relay, ctx);
            }
            break;
        }
    }
}

// ─── Notification Buffering ─────────────────────────────────────────
// When the dashboard is open, buffer pi.sendMessage calls so they don't
// cause terminal scroll that corrupts the dashboard render.

type BufferedMessage = {
    message: Parameters<ExtensionAPI["sendMessage"]>[0];
    options?: Parameters<ExtensionAPI["sendMessage"]>[1];
};

const messageBuffer: BufferedMessage[] = [];
let flushInterval: ReturnType<typeof setInterval> | null = null;

function bufferedSendMessage(
    pi: ExtensionAPI,
    message: BufferedMessage["message"],
    options?: BufferedMessage["options"],
): void {
    if (isDashboardOpen()) {
        messageBuffer.push({ message, options });
        return;
    }
    pi.sendMessage(message, options);
}

function startBufferFlush(pi: ExtensionAPI): void {
    if (flushInterval) return;
    flushInterval = setInterval(() => {
        if (!isDashboardOpen() && messageBuffer.length > 0) {
            const pending = messageBuffer.splice(0);
            for (const { message, options } of pending) {
                pi.sendMessage(message, options);
            }
        }
    }, 500);
}

export function registerSwarmTool(pi: ExtensionAPI): void {
    startBufferFlush(pi);
    pi.registerTool({
        name: "swarm",
        label: "Swarm",
        description:
            "Delegate work to agents. Behavior adapts to the call:\n" +
            "- **1 agent**: Runs synchronously, returns the result (blocking).\n" +
            "- **Multiple agents**: Spawns async swarm with channel coordination.\n" +
            "- **chain**: Sequential agents where each gets the previous output.\n" +
            "- Override with `blocking: true/false` to force mode.\n" +
            "Use `agentScope` to include project-local agents from .pi/agents/.",
        parameters: SwarmParams,

        async execute(_toolCallId, params, signal, onUpdate, ctx) {
            // ── Mode Detection ──────────────────────────────────
            const isChain = !!(params.chain && params.chain.length > 0);
            const isBlocking = shouldBlock(params);
            const identity = getIdentity();

            // Role check: plain agents can only use blocking mode
            if (!isBlocking && identity.role === "agent") {
                return {
                    content: [{
                        type: "text",
                        text: "Agents can only use blocking mode. " +
                            "Set `blocking: true` or use a single agent (auto-blocks).",
                    }],
                    details: {},
                    isError: true,
                };
            }

            // ── Agent Discovery ─────────────────────────────────
            const scope: AgentScope = (params.agentScope as AgentScope) || "user";
            const { agents: knownAgents, projectAgentsDir } = discoverAgents(ctx.cwd, scope);

            // Confirm project agents if applicable
            if (
                scope !== "user" &&
                projectAgentsDir &&
                params.confirmProjectAgents !== false &&
                ctx.hasUI
            ) {
                const confirmed = await (ctx.ui as any).confirm(
                    "Project Agents",
                    `Project agents found in ${projectAgentsDir}. Allow?`,
                );
                if (!confirmed) {
                    return {
                        content: [{ type: "text", text: "Project agent use declined by user." }],
                        details: {},
                        isError: true,
                    };
                }
            }

            // ── Chain Mode ──────────────────────────────────────
            if (isChain) {
                const { results } = await executeChain(
                    params.chain!,
                    ctx.cwd,
                    knownAgents,
                    signal,
                    onUpdate,
                );

                const usage = aggregateUsage(results);
                const anyFailed = results.some(r => r.exitCode !== 0);

                return {
                    content: [{
                        type: "text",
                        text: formatBlockingResult(results, "chain"),
                    }],
                    details: {
                        mode: "blocking",
                        blockingMode: "chain",
                        results,
                        usage,
                    },
                    isError: anyFailed,
                };
            }

            // ── Blocking Mode (single or parallel) ──────────────
            if (isBlocking) {
                const agentSpecs = params.agents.map(a => ({
                    name: a.name,
                    task: a.task,
                    agent: a.agent,
                    model: a.model,
                    cwd: a.cwd,
                }));

                const { results, mode } = await executeBlocking(
                    agentSpecs,
                    ctx.cwd,
                    knownAgents,
                    signal,
                    onUpdate,
                );

                const usage = aggregateUsage(results);
                const anyFailed = results.some(r => r.exitCode !== 0);

                return {
                    content: [{
                        type: "text",
                        text: formatBlockingResult(results, mode),
                    }],
                    details: {
                        mode: "blocking",
                        blockingMode: mode,
                        results,
                        usage,
                    },
                    isError: anyFailed,
                };
            }

            // ── Async Mode (existing swarm behavior) ────────────

            // Check for existing swarm — clean up if all agents are finished
            const existingState = getSwarmState();
            if (existingState) {
                const allFinished = Array.from(existingState.agents.values()).every(
                    (a) => a.status === "done" || a.status === "crashed" || a.status === "disconnected",
                );
                if (allFinished) {
                    await cleanupSwarm();
                    clearActivity();
                } else {
                    return {
                        content: [
                            {
                                type: "text",
                                text: "A swarm is already active with running agents. Check swarm_status or wait for completion.",
                            },
                        ],
                        details: {},
                        isError: true,
                    };
                }
            }

            // Generation counter
            let gen: number;

            // Create channel group
            const swarmId = generateSwarmId();
            const agentNames = params.agents.map((a) => a.name);
            const swarmAgents = params.agents.map((a) => ({ name: a.name, swarm: a.swarm }));
            let group;
            let topicChannels: Map<string, string>;
            try {
                const result = await createSwarmChannelGroup(swarmId, swarmAgents);
                group = result.group;
                topicChannels = result.topicChannels;
            } catch (err) {
                return {
                    content: [{ type: "text", text: `Failed to create channel group: ${err}` }],
                    details: {},
                    isError: true,
                };
            }

            // Build agent info map
            const agentMap = new Map<string, AgentInfo>();
            for (const agentDef of params.agents) {
                agentMap.set(agentDef.name, {
                    name: agentDef.name,
                    role: agentDef.role,
                    swarm: agentDef.swarm,
                    task: agentDef.task,
                    status: "starting",
                });
            }

            // Scaffold task directory
            let taskDirPath: string | undefined;
            let scaffoldResult: ScaffoldResult | undefined;
            const parentTaskDir = process.env.PI_SWARM_TASK_DIR;

            if (params.taskDir) {
                taskDirPath = params.taskDir.path;
                scaffoldResult = scaffoldTaskDir(
                    taskDirPath,
                    params.taskDir.overview,
                    Array.from(agentMap.values()),
                );
            } else if (parentTaskDir) {
                const mySwarm = getIdentity().swarm || "default";
                scaffoldResult = scaffoldCoordinatorSubDir(
                    parentTaskDir,
                    mySwarm,
                    undefined,
                    Array.from(agentMap.values()),
                );
                taskDirPath = scaffoldResult.taskDirPath;
            }

            // Connect queen to all channels for monitoring
            const allChannelNames = [
                GENERAL_CHANNEL,
                QUEEN_INBOX,
                ...agentNames.map(inboxName),
                ...topicChannels.values(),
            ];
            let queenClients;
            try {
                queenClients = await connectToMultiple(group.path, allChannelNames);
            } catch (err) {
                await group.stop({ removeDir: true });
                return {
                    content: [{ type: "text", text: `Failed to connect queen to channels: ${err}` }],
                    details: {},
                    isError: true,
                };
            }

            // Set up state
            const state: SwarmState = {
                generation: 0,
                group,
                groupPath: group.path,
                agents: agentMap,
                taskDirPath,
                queenClients,
            };

            // Wire up notifications to pi.sendMessage
            state.onAgentDone = (_agentName, _summary) => {
                if (getSwarmGeneration() !== gen) return;
                // Dashboard update handled by handleQueenMessage after status update
            };

            state.onAllDone = () => {
                if (getSwarmGeneration() !== gen) return;
                bufferedSendMessage(pi,
                    {
                        customType: "swarm-complete",
                        content:
                            "🐝 **All swarm agents have completed.**\n\n" +
                            "Read the hive-mind file and agent reports to synthesize findings. " +
                            "Use `swarm_status` to see individual results.",
                        display: true,
                    },
                    { deliverAs: "followUp", triggerTurn: true },
                );
                updateDashboard(ctx);
            };

            state.onBlocker = (agentName, description) => {
                if (getSwarmGeneration() !== gen) return;
                bufferedSendMessage(pi,
                    {
                        customType: "swarm-blocker",
                        content: `⚠️ **Agent ${agentName} is blocked:** ${description}\n\nUse \`swarm_instruct\` to help, or check the hive-mind file.`,
                        display: true,
                    },
                    { deliverAs: "steer" },
                );
                updateDashboard(ctx);
            };

            state.onNudge = (reason, from) => {
                if (getSwarmGeneration() !== gen) return;
                bufferedSendMessage(pi,
                    {
                        customType: "swarm-nudge",
                        content: `🔔 **${from}** updated the hive-mind: ${reason}`,
                        display: true,
                    },
                    { deliverAs: "followUp" },
                );
            };

            setSwarmState(state);
            gen = getSwarmGeneration();

            // Set up message listeners on all queen channels
            for (const [channelName, client] of queenClients.entries()) {
                client.on("message", (msg: Message) => {
                    if (getSwarmGeneration() !== gen) return;
                    const currentState = getSwarmState();
                    if (!currentState) return;
                    handleQueenMessage(currentState, gen, msg, channelName, agentMap, ctx, pi);
                });
            }

            // knownAgents already discovered above (before mode dispatch)

            // Spawn all agents
            for (const agentDef of params.agents) {
                const agentInfo = agentMap.get(agentDef.name)!;
                const agentFileInfo = scaffoldResult?.agentFiles.get(agentDef.name);
                const agentTopicChannel = topicChannels.get(agentDef.swarm);
                const { process: proc } = spawnAgent(
                    agentDef, group.path, taskDirPath, ctx.cwd, knownAgents, agentFileInfo, agentNames, agentTopicChannel,
                );

                agentInfo.process = proc;

                // Capture stderr for debugging
                let stderr = "";
                proc.stderr?.on("data", (data: Buffer) => {
                    stderr = (stderr + data.toString()).slice(-2048);
                });

                // Track process exit
                proc.on("close", (code: number | null) => {
                    if (getSwarmGeneration() !== gen) return;
                    const current = getSwarmState();
                    if (!current) return;
                    const agent = current.agents.get(agentDef.name);
                    if (agent && agent.status !== "done") {
                        if (code === 0) {
                            updateAgentStatus(agentDef.name, "done");
                        } else {
                            updateAgentStatus(agentDef.name, "crashed");

                            // Build crash info with last activity
                            const activity = getAgentActivity(agentDef.name);
                            const lastActivity = activity.slice(-3).map(e => e.summary).join("; ");
                            const crashInfo = `💀 **${agentDef.name}** crashed (exit code ${code}).` +
                                (lastActivity ? `\nLast activity: ${lastActivity}` : "") +
                                (stderr ? `\n\nLast stderr:\n\`\`\`\n${stderr.slice(-500)}\n\`\`\`` : "");

                            // Broadcast to general channel so other agents can adjust
                            const generalClient = current.queenClients.get(GENERAL_CHANNEL);
                            if (generalClient?.connected) {
                                try {
                                    generalClient.send({
                                        msg: `Agent ${agentDef.name} crashed (exit code ${code})`,
                                        data: {
                                            type: "agent_crashed",
                                            from: "system",
                                            agent: agentDef.name,
                                            exitCode: code,
                                            lastActivity: lastActivity || undefined,
                                        },
                                    });
                                } catch { /* best effort */ }
                            }

                            // Active interrupt to queen
                            bufferedSendMessage(pi,
                                {
                                    customType: "swarm-blocker",
                                    content: crashInfo,
                                    display: true,
                                },
                                { deliverAs: "steer" },
                            );
                        }
                        updateDashboard(ctx);
                    }
                });

                proc.on("error", (err: Error) => {
                    if (getSwarmGeneration() !== gen) return;
                    updateAgentStatus(agentDef.name, "crashed");

                    // Broadcast spawn failure to general channel
                    const current = getSwarmState();
                    const generalClient = current?.queenClients.get(GENERAL_CHANNEL);
                    if (generalClient?.connected) {
                        try {
                            generalClient.send({
                                msg: `Agent ${agentDef.name} failed to start: ${err.message}`,
                                data: {
                                    type: "agent_crashed",
                                    from: "system",
                                    agent: agentDef.name,
                                    exitCode: -1,
                                    error: err.message,
                                },
                            });
                        } catch { /* best effort */ }
                    }

                    bufferedSendMessage(pi,
                        {
                            customType: "swarm-blocker",
                            content: `💀 **${agentDef.name}** failed to start: ${err.message}`,
                            display: true,
                        },
                        { deliverAs: "steer" },
                    );
                    updateDashboard(ctx);
                });

                if (proc.stdout) {
                    trackAgentOutput(agentDef.name, proc.stdout);
                }
            }

            // Timeout for agents stuck in "starting"
            setTimeout(() => {
                if (getSwarmGeneration() !== gen) return;
                const current = getSwarmState();
                if (!current) return;
                for (const agent of current.agents.values()) {
                    if (agent.status === "starting") {
                        updateAgentStatus(agent.name, "crashed");
                        bufferedSendMessage(pi,
                            {
                                customType: "swarm-blocker",
                                content: `💀 **${agent.name}** failed to register within 30s — marked as crashed.`,
                                display: true,
                            },
                            { deliverAs: "steer" },
                        );
                    }
                }
                updateDashboard(ctx);
            }, 30_000);

            // Initialize dashboard
            updateDashboard(ctx);

            // Return immediately
            const agentList = params.agents
                .map((a) => `- **${a.name}** (${a.role}, swarm: ${a.swarm})`)
                .join("\n");

            return {
                content: [
                    {
                        type: "text",
                        text:
                            `Swarm started with ${params.agents.length} agent(s):\n${agentList}\n\n` +
                            `Channels: ${group.path}\n` +
                            (taskDirPath ? `Task dir: ${taskDirPath}\n` : "") +
                            `\nAgents are running in the background. ` +
                            `Use \`swarm_status\` to check progress, \`swarm_instruct\` to send instructions.`,
                    },
                ],
                details: {
                    agentCount: params.agents.length,
                    groupPath: group.path,
                    taskDirPath,
                },
            };
        },

        renderCall(args, theme) {
            const isChain = args.chain && args.chain.length > 0;
            const isBlocking = shouldBlock(args as any);

            if (isChain) {
                // Chain mode rendering
                const count = args.chain!.length;
                let text =
                    theme.fg("toolTitle", theme.bold("swarm ")) +
                    theme.fg("accent", `chain ${count} step${count !== 1 ? "s" : ""}`) +
                    theme.fg("dim", " (blocking)");

                for (let i = 0; i < Math.min(count, 4); i++) {
                    const step = args.chain![i];
                    const preview = step.task.length > 50 ? `${step.task.slice(0, 50)}...` : step.task;
                    text += `\n  ${theme.fg("accent", `${i + 1}. ${step.agent}`)}${theme.fg("dim", ` ${preview}`)}`;
                }
                if (count > 4) {
                    text += `\n  ${theme.fg("muted", `... +${count - 4} more`)}`;
                }
                return new Text(text, 0, 0);
            }

            const count = args.agents?.length || 0;
            const modeLabel = isBlocking ? " (blocking)" : "";
            let text =
                theme.fg("toolTitle", theme.bold("swarm ")) +
                theme.fg("accent", `${count} agent${count !== 1 ? "s" : ""}`) +
                theme.fg("dim", modeLabel);

            if (args.taskDir?.path) {
                text += theme.fg("dim", ` task:${args.taskDir.path}`);
            }

            for (const a of (args.agents || []).slice(0, 4)) {
                const rolePart = (a as any).role ? ` (${(a as any).role})` : "";
                const preview = a.task.length > 50 ? `${a.task.slice(0, 50)}...` : a.task;
                text += `\n  ${theme.fg("accent", a.name)}${rolePart}${theme.fg("dim", ` ${preview}`)}`;
            }
            if (count > 4) {
                text += `\n  ${theme.fg("muted", `... +${count - 4} more`)}`;
            }

            return new Text(text, 0, 0);
        },

        renderResult(result, opts, theme) {
            const details = result.details as any;

            // Blocking mode — use rich rendering
            if (details?.mode === "blocking" && details.results) {
                const results = details.results as SingleResult[];
                const blockingMode = details.blockingMode as string;
                const expanded = opts?.expanded ?? false;

                if (blockingMode === "chain") {
                    return expanded
                        ? renderBlockingMultiExpanded(results, "chain", theme)
                        : renderChainResult(results, theme);
                }

                if (blockingMode === "parallel") {
                    return expanded
                        ? renderBlockingMultiExpanded(results, "parallel", theme)
                        : renderBlockingMulti(results, theme);
                }

                // Single blocking
                if (results.length === 1) {
                    return expanded
                        ? renderBlockingSingleExpanded(results[0], theme)
                        : renderBlockingSingle(results[0], theme);
                }
            }

            // Async mode — simple text rendering
            const text = result.content[0];
            const content = text?.type === "text" ? text.text : "(no output)";
            const color = result.isError ? "error" : "success";
            const icon = result.isError ? "✗" : "🐝";
            return new Text(`${icon} ${theme.fg(color, content)}`, 0, 0);
        },
    });
}
