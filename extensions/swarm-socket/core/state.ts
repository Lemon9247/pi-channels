/**
 * Swarm State
 *
 * Module-level persistent state for the swarm extension.
 * Since the swarm tool returns immediately, we need to track
 * spawned processes, channel group, and agent status.
 */

import type { ChildProcess } from "node:child_process";
import type { ChannelGroup } from "../../../../agent-channels/dist/index.js";
import type { ChannelClient } from "../../../../agent-channels/dist/index.js";

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

export async function cleanupSwarm(): Promise<void> {
    if (!activeSwarm) return;

    // Kill all child processes and their subtrees (process groups)
    for (const agent of activeSwarm.agents.values()) {
        if (agent.process && !agent.process.killed && agent.process.pid) {
            try {
                process.kill(-agent.process.pid, "SIGTERM");
            } catch {
                try { agent.process.kill("SIGTERM"); } catch { /* ignore */ }
            }
            const pid = agent.process.pid;
            setTimeout(() => {
                try { process.kill(-pid, "SIGKILL"); } catch { /* ignore */ }
            }, 5000);
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
}
