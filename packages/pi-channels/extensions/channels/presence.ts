import { type AgentStatus, type ChannelsConfig } from "./types.js";
import * as registry from "./registry.js";

/**
 * Track local activity for the current agent.
 */
let lastActivityTime = Date.now();
let lastAutoStatusTime = 0;
let toolCount = 0;
let currentActivity = "";

/**
 * Record activity (tool call, etc).
 */
export function recordActivity(description?: string): void {
    lastActivityTime = Date.now();
    toolCount++;
    if (description) {
        currentActivity = description;
    }
}

/**
 * Clear current activity (after tool_result).
 */
export function clearActivity(): void {
    currentActivity = "";
}

/**
 * Get time since last activity in ms.
 */
export function getIdleMs(): number {
    return Date.now() - lastActivityTime;
}

/**
 * Get current tool count (reset per session).
 */
export function getToolCount(): number {
    return toolCount;
}

/**
 * Get current activity description.
 */
export function getCurrentActivity(): string {
    return currentActivity;
}

/**
 * Check if auto-status can be sent (rate-limited to 1 per 30s).
 */
export function canSendAutoStatus(): boolean {
    const now = Date.now();
    if (now - lastAutoStatusTime >= 30_000) {
        lastAutoStatusTime = now;
        return true;
    }
    return false;
}

/**
 * Flush activity timestamp to registry.
 */
export function flushActivityToRegistry(name: string, config: ChannelsConfig): void {
    const status = registry.computeStatus(
        new Date(lastActivityTime).toISOString(),
        registry.getAgent(name)?.reservations ?? [],
        config.stuckThreshold,
    );

    registry.updateAgent(name, {
        lastActivity: new Date(lastActivityTime).toISOString(),
        status,
    });
}

/**
 * Check all agents for stuck status and return stuck agents.
 */
export function checkStuckAgents(
    myName: string,
    config: ChannelsConfig,
    projectDir: string,
): Array<{ name: string; idleMinutes: number; reason: string }> {
    if (!config.stuckNotify) return [];

    const stuck: Array<{ name: string; idleMinutes: number; reason: string }> = [];
    const agents = registry.listAgentsForProject(projectDir);

    for (const agent of agents) {
        if (agent.name === myName) continue;

        const status = registry.computeStatus(
            agent.lastActivity,
            agent.reservations,
            config.stuckThreshold,
        );

        if (status === "stuck") {
            const idleMs = Date.now() - new Date(agent.lastActivity).getTime();
            const idleMinutes = Math.round(idleMs / 60_000);
            const reservedPaths = agent.reservations.map((r) => r.paths.join(", ")).join("; ");
            stuck.push({
                name: agent.name,
                idleMinutes,
                reason: `idle ${idleMinutes}m with reservation on ${reservedPaths}`,
            });
        }
    }

    return stuck;
}

/**
 * Format a status emoji.
 */
export function statusEmoji(status: AgentStatus): string {
    switch (status) {
        case "active": return "🟢";
        case "idle": return "🟡";
        case "away": return "🟠";
        case "stuck": return "🔴";
    }
}

/**
 * Reset presence state (for testing).
 */
export function reset(): void {
    lastActivityTime = Date.now();
    lastAutoStatusTime = 0;
    toolCount = 0;
    currentActivity = "";
}
