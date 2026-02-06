/**
 * Swarm State
 *
 * Module-level persistent state for the swarm extension.
 * Since the swarm tool returns immediately, we need to track
 * spawned processes, socket server, and agent status.
 */

import type { ChildProcess } from "node:child_process";
import type { SwarmServer } from "./server.js";
import type { SwarmClient } from "./client.js";

export type AgentStatus = "starting" | "running" | "done" | "blocked" | "disconnected" | "crashed";

export interface AgentInfo {
    name: string;
    role: "coordinator" | "agent";
    swarm: string;
    task: string;
    status: AgentStatus;
    code: string;     // Hierarchical address: "0.1.2" (queen=0, its children=0.1, 0.2, ...)
    process?: ChildProcess;
    doneSummary?: string;
    blockerDescription?: string;
}

/** Sub-agent relay payload — JSON-encoded in nudge reason field */
export interface SubAgentRelay {
    sub: true;
    type: "register" | "done" | "blocked" | "nudge" | "disconnected";
    name: string;
    role: string;
    swarm: string;
    code: string;     // Hierarchical address of the sub-agent
    summary?: string;
    description?: string;
    reason?: string;
}

/** Try to parse a nudge reason as a sub-agent relay. Returns null if not a relay. */
export function parseSubRelay(reason: string): SubAgentRelay | null {
    if (!reason.startsWith("{")) return null;
    try {
        const obj = JSON.parse(reason);
        if (obj && obj.sub === true) return obj as SubAgentRelay;
    } catch { /* not JSON */ }
    return null;
}

export interface SwarmState {
    generation: number;  // Monotonic ID — callbacks check this to detect stale swarms
    server: SwarmServer | null; // null if we're reusing existing socket (coordinator)
    socketPath: string;
    agents: Map<string, AgentInfo>;
    taskDirPath?: string;

    // Callbacks for the extension to hook into
    onAgentDone?: (agentName: string, summary: string) => void;
    onAllDone?: () => void;
    onBlocker?: (agentName: string, description: string, from: string) => void;
    onNudge?: (reason: string, from: string) => void;
}

let activeSwarm: SwarmState | null = null;
let parentClient: SwarmClient | null = null;
let swarmGeneration = 0;

export function getSwarmState(): SwarmState | null {
    return activeSwarm;
}

export function getSwarmGeneration(): number {
    return swarmGeneration;
}

export function setSwarmState(state: SwarmState): void {
    swarmGeneration++;
    state.generation = swarmGeneration;
    activeSwarm = state;
}

export function getParentClient(): SwarmClient | null {
    return parentClient;
}

export function setParentClient(client: SwarmClient | null): void {
    parentClient = client;
}

export function updateAgentStatus(name: string, status: AgentStatus, extra?: Partial<AgentInfo>): void {
    if (!activeSwarm) return;
    const agent = activeSwarm.agents.get(name);
    if (!agent) return;
    agent.status = status;
    if (extra) Object.assign(agent, extra);

    // Check if all agents are done
    checkAllDone();
}

function checkAllDone(): void {
    if (!activeSwarm) return;
    const allDone = Array.from(activeSwarm.agents.values()).every(
        (a) => a.status === "done" || a.status === "crashed" || a.status === "disconnected",
    );
    if (allDone) {
        activeSwarm.onAllDone?.();
    }
}

/**
 * Graceful shutdown: ask agents to wrap up, wait for completion, then force-kill stragglers.
 */
export async function gracefulShutdown(
    server: SwarmServer,
    sendInstruct: (instruction: string) => void,
): Promise<void> {
    const gen = swarmGeneration; // capture — don't kill a newer swarm
    sendInstruct(
        "Wrap up your current work, write findings to hive-mind, and call hive_done. You have 30 seconds.",
    );

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        if (!activeSwarm || activeSwarm.generation !== gen) return; // stale or replaced
        const allFinished = Array.from(activeSwarm.agents.values()).every(
            (a) => a.status === "done" || a.status === "crashed" || a.status === "disconnected",
        );
        if (allFinished) break;
    }

    if (!activeSwarm || activeSwarm.generation !== gen) return; // check before cleanup
    await cleanupSwarm();
}

export async function cleanupSwarm(): Promise<void> {
    if (!activeSwarm) return;

    // Kill all child processes and their subtrees (process groups)
    for (const agent of activeSwarm.agents.values()) {
        if (agent.process && !agent.process.killed && agent.process.pid) {
            try {
                // Kill the entire process group (coordinator + its sub-agents)
                process.kill(-agent.process.pid, "SIGTERM");
            } catch {
                // Process group may not exist; fall back to direct kill
                try { agent.process.kill("SIGTERM"); } catch { /* ignore */ }
            }
            // Force kill after 5 seconds
            const pid = agent.process.pid;
            setTimeout(() => {
                try { process.kill(-pid, "SIGKILL"); } catch { /* ignore */ }
            }, 5000);
        }
    }

    // Stop server if we own it
    if (activeSwarm.server) {
        await activeSwarm.server.stop();
    }

    activeSwarm = null;
}
