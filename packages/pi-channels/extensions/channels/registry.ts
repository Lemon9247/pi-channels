import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { type RegistryEntry, type AgentStatus, type Reservation } from "./types.js";

const REGISTRY_DIR = path.join(os.homedir(), ".pi", "agent", "channels", "registry");

/**
 * Ensure registry directory exists.
 */
export function ensureRegistryDir(): void {
    fs.mkdirSync(REGISTRY_DIR, { recursive: true });
}

/**
 * Register an agent in the registry.
 */
export function registerAgent(entry: RegistryEntry): void {
    ensureRegistryDir();
    const filepath = path.join(REGISTRY_DIR, `${entry.name}.json`);
    try {
        fs.writeFileSync(filepath, JSON.stringify(entry, null, 2) + "\n");
    } catch (err) {
        console.error("[pi-channels] Failed to write registry entry:", err);
    }
}

/**
 * Update specific fields of a registry entry.
 */
export function updateAgent(name: string, updates: Partial<RegistryEntry>): void {
    const entry = getAgent(name);
    if (!entry) return;
    const updated = { ...entry, ...updates };
    registerAgent(updated);
}

/**
 * Remove an agent from the registry.
 */
export function unregisterAgent(name: string): void {
    const filepath = path.join(REGISTRY_DIR, `${name}.json`);
    try {
        fs.unlinkSync(filepath);
    } catch {
        // Ignore
    }
}

/**
 * Get a single agent's registry entry.
 */
export function getAgent(name: string): RegistryEntry | null {
    const filepath = path.join(REGISTRY_DIR, `${name}.json`);
    try {
        const raw = fs.readFileSync(filepath, "utf-8");
        return JSON.parse(raw) as RegistryEntry;
    } catch {
        return null;
    }
}

/**
 * List all registered agents.
 */
export function listAgents(): RegistryEntry[] {
    ensureRegistryDir();
    const entries: RegistryEntry[] = [];
    try {
        const files = fs.readdirSync(REGISTRY_DIR).filter((f) => f.endsWith(".json"));
        for (const file of files) {
            try {
                const raw = fs.readFileSync(path.join(REGISTRY_DIR, file), "utf-8");
                entries.push(JSON.parse(raw) as RegistryEntry);
            } catch {
                // Skip corrupt entries
            }
        }
    } catch {
        // Directory doesn't exist yet
    }
    return entries;
}

/**
 * List all registered agents for a specific project folder.
 * Agents are visible if their cwd is the same folder or a subfolder of the projectDir.
 */
export function listAgentsForProject(projectDir: string): RegistryEntry[] {
    const all = listAgents();
    return all.filter((agent) => {
        // Agent is visible if their cwd is the same as or under projectDir
        return agent.cwd === projectDir || agent.cwd.startsWith(projectDir + "/");
    });
}

/**
 * Get the set of all currently registered names.
 */
export function registeredNames(): Set<string> {
    return new Set(listAgents().map((a) => a.name));
}

/**
 * Check if a PID is alive.
 */
export function isPidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

/**
 * Cleanup stale registry entries from crashed agents.
 * Returns names of cleaned entries.
 */
export function cleanupStaleEntries(): string[] {
    const cleaned: string[] = [];
    const agents = listAgents();

    for (const agent of agents) {
        if (!isPidAlive(agent.pid)) {
            unregisterAgent(agent.name);
            cleaned.push(agent.name);
        }
    }

    return cleaned;
}

/**
 * Compute agent status based on activity timestamps.
 */
export function computeStatus(
    lastActivity: string,
    reservations: Reservation[],
    stuckThreshold: number,
): AgentStatus {
    const now = Date.now();
    const last = new Date(lastActivity).getTime();
    const idleMs = now - last;

    if (idleMs < 30_000) return "active";
    if (idleMs < 300_000) return "idle";

    // 5min+ inactive
    if (reservations.length > 0 && idleMs >= stuckThreshold * 1000) {
        return "stuck";
    }

    return "away";
}

/**
 * Get the registry directory path.
 */
export function getRegistryDir(): string {
    return REGISTRY_DIR;
}
