/**
 * Swarm State
 *
 * Module-level persistent state for the swarm extension.
 * Since the swarm tool returns immediately, we need to track
 * spawned processes, channel group, and agent status.
 */

import type { ChildProcess } from "node:child_process";
import type { ChannelGroup, ChannelClient } from "agent-channels";

export type AgentStatus = "starting" | "running" | "done" | "blocked" | "disconnected" | "crashed";

export interface AgentInfo {
    name: string;
    role: "coordinator" | "agent";
    swarm: string;
    task: string;
    status: AgentStatus;
    process?: ChildProcess;
    doneSummary?: string;
    blockerDescription?: string;
    progressPhase?: string;
    progressPercent?: number;
    progressDetail?: string;
}

export interface SwarmState {
    generation: number;
    group: ChannelGroup | null;
    groupPath: string;
    agents: Map<string, AgentInfo>;
    taskDirPath?: string;

    /** Queen's connected ChannelClients for monitoring all channels. */
    queenClients: Map<string, ChannelClient>;

    // Callbacks for the extension to hook into
    onAgentDone?: (agentName: string, summary: string) => void;
    onAllDone?: () => void;
    onBlocker?: (agentName: string, description: string) => void;
    onNudge?: (reason: string, from: string) => void;
}

// ─── State Machine ──────────────────────────────────────────────────

/**
 * Valid agent status transitions.
 * Key = current status, value = set of allowed next statuses.
 *
 * Transition rules:
 * - starting → running (agent registered), crashed (failed to start), disconnected (process exited)
 * - running → done (hive_done), blocked (hive_blocker), crashed (timeout/error), disconnected (process exited)
 * - blocked → running (unblocked), done (completed despite blocker), crashed (timeout), disconnected
 * - done/crashed/disconnected → terminal, no transitions out
 */
export const VALID_TRANSITIONS: Record<AgentStatus, Set<AgentStatus>> = {
    starting:      new Set(["running", "crashed", "disconnected"]),
    running:       new Set(["done", "blocked", "crashed", "disconnected"]),
    blocked:       new Set(["running", "done", "crashed", "disconnected"]),
    done:          new Set(),
    crashed:       new Set(),
    disconnected:  new Set(),
};

/**
 * Check if a status transition is valid.
 */
export function isValidTransition(from: AgentStatus, to: AgentStatus): boolean {
    return VALID_TRANSITIONS[from].has(to);
}

// ─── Module State ───────────────────────────────────────────────────

let activeSwarm: SwarmState | null = null;
let parentClients: Map<string, ChannelClient> | null = null;
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

/** Get the agent's connected channels (inbox, general, etc.). */
export function getParentClients(): Map<string, ChannelClient> | null {
    return parentClients;
}

/** Set the agent's connected channels. */
export function setParentClients(clients: Map<string, ChannelClient> | null): void {
    parentClients = clients;
}

/**
 * Update an agent's status, enforcing the state machine.
 * Invalid transitions are silently ignored (returns false).
 */
export function updateAgentStatus(name: string, status: AgentStatus, extra?: Partial<AgentInfo>): boolean {
    if (!activeSwarm) return false;
    const agent = activeSwarm.agents.get(name);
    if (!agent) return false;

    // Enforce state machine — reject invalid transitions
    if (!isValidTransition(agent.status, status)) {
        return false;
    }

    agent.status = status;
    if (extra) Object.assign(agent, extra);

    // Check if all agents are done
    checkAllDone();
    return true;
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
    sendInstruct: (instruction: string) => void,
): Promise<void> {
    const gen = swarmGeneration;
    sendInstruct(
        "Wrap up your current work, write findings to hive-mind, and call hive_done. You have 30 seconds.",
    );

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        if (!activeSwarm || activeSwarm.generation !== gen) return;
        const allFinished = Array.from(activeSwarm.agents.values()).every(
            (a) => a.status === "done" || a.status === "crashed" || a.status === "disconnected",
        );
        if (allFinished) break;
    }

    if (!activeSwarm || activeSwarm.generation !== gen) return;
    await cleanupSwarm();
}

/**
 * Check if a PID is still alive and belongs to one of our agent processes.
 * Prevents killing a recycled PID that now belongs to an unrelated process.
 */
function isOurProcess(pid: number, agents: Map<string, AgentInfo>): boolean {
    // Check if the PID still matches a tracked agent process
    for (const agent of agents.values()) {
        if (agent.process?.pid === pid) {
            try {
                // signal 0 checks existence without killing
                process.kill(pid, 0);
                return true;
            } catch {
                return false;
            }
        }
    }
    return false;
}

export async function cleanupSwarm(): Promise<void> {
    if (!activeSwarm) return;

    // Snapshot agents before cleanup — we'll null activeSwarm at the end
    const agents = activeSwarm.agents;

    // Kill all child processes and their subtrees (process groups)
    const killPromises: Promise<void>[] = [];
    for (const agent of agents.values()) {
        if (agent.process && !agent.process.killed && agent.process.pid) {
            const pid = agent.process.pid;

            // Verify PID still belongs to us before killing
            if (!isOurProcess(pid, agents)) continue;

            try {
                process.kill(-pid, "SIGTERM");
            } catch {
                try { agent.process.kill("SIGTERM"); } catch { /* ignore */ }
            }

            // Schedule SIGKILL after 5s, re-verify PID before killing
            killPromises.push(
                new Promise<void>((resolve) => {
                    setTimeout(() => {
                        if (isOurProcess(pid, agents)) {
                            try { process.kill(-pid, "SIGKILL"); } catch { /* ignore */ }
                        }
                        resolve();
                    }, 5000);
                }),
            );
        }
    }

    // Disconnect queen's monitoring clients
    for (const client of activeSwarm.queenClients.values()) {
        try { client.disconnect(); } catch { /* ignore */ }
    }
    activeSwarm.queenClients.clear();

    // Stop channel group and remove directory
    if (activeSwarm.group) {
        try {
            await activeSwarm.group.stop({ removeDir: true });
        } catch { /* ignore */ }
    }

    activeSwarm = null;

    // Don't await killPromises — they're 5s timeouts. Fire and forget.
    // The SIGTERM above is the real cleanup; SIGKILL is the safety net.
}
