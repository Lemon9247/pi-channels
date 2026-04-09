import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type AgentStatus, type RegistryEntry } from "./types.js";

const REGISTRY_DIR = path.join(os.homedir(), ".pi", "agent", "channels", "registry");

let lastActivityTime = Date.now();
let lastAutoStatusTime = 0;
let toolCount = 0;
let currentActivity = "";

export function ensureRegistryDir(): void {
    fs.mkdirSync(REGISTRY_DIR, { recursive: true });
}

export function registerAgent(entry: RegistryEntry): void {
    ensureRegistryDir();
    const filepath = path.join(REGISTRY_DIR, `${entry.name}.json`);
    try {
        fs.writeFileSync(filepath, JSON.stringify(entry, null, 2) + "\n");
    } catch (err) {
        console.error("[pi-channels] Failed to write registry entry:", err);
    }
}

export function updateAgent(name: string, updates: Partial<RegistryEntry>): void {
    const entry = getAgent(name);
    if (!entry) return;
    registerAgent({ ...entry, ...updates });
}

export function unregisterAgent(name: string): void {
    const filepath = path.join(REGISTRY_DIR, `${name}.json`);
    try {
        fs.unlinkSync(filepath);
    } catch {
        // Best effort.
    }
}

export function getAgent(name: string): RegistryEntry | null {
    const filepath = path.join(REGISTRY_DIR, `${name}.json`);
    try {
        return JSON.parse(fs.readFileSync(filepath, "utf-8")) as RegistryEntry;
    } catch {
        return null;
    }
}

export function listAgents(): RegistryEntry[] {
    ensureRegistryDir();
    const entries: RegistryEntry[] = [];

    try {
        const files = fs.readdirSync(REGISTRY_DIR).filter((file) => file.endsWith(".json"));
        for (const file of files) {
            try {
                entries.push(JSON.parse(fs.readFileSync(path.join(REGISTRY_DIR, file), "utf-8")) as RegistryEntry);
            } catch {
                // Skip corrupt entries.
            }
        }
    } catch {
        // No registry yet.
    }

    return entries;
}

export function listAgentsForProject(projectDir: string): RegistryEntry[] {
    return listAgents().filter((agent) => {
        return agent.cwd === projectDir || agent.cwd.startsWith(projectDir + "/");
    });
}

export function registeredNames(): Set<string> {
    return new Set(listAgents().map((entry) => entry.name));
}

export function isPidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

export function cleanupStaleEntries(): string[] {
    const cleaned: string[] = [];
    for (const agent of listAgents()) {
        if (!isPidAlive(agent.pid)) {
            unregisterAgent(agent.name);
            cleaned.push(agent.name);
        }
    }
    return cleaned;
}

export function computeStatus(lastActivity: string): AgentStatus {
    const idleMs = Date.now() - new Date(lastActivity).getTime();
    if (idleMs < 30_000) return "active";
    if (idleMs < 300_000) return "idle";
    return "away";
}

export function statusEmoji(status: AgentStatus): string {
    switch (status) {
        case "active":
            return "☸";
        case "idle":
            return "☾";
        case "away":
            return "☽";
    }
}

export function recordActivity(description?: string): void {
    lastActivityTime = Date.now();
    toolCount++;
    if (description) {
        currentActivity = description;
    }
}

export function clearActivity(): void {
    currentActivity = "";
}

export function getToolCount(): number {
    return toolCount;
}

export function getCurrentActivity(): string {
    return currentActivity;
}

export function canSendAutoStatus(): boolean {
    const now = Date.now();
    if (now - lastAutoStatusTime >= 30_000) {
        lastAutoStatusTime = now;
        return true;
    }
    return false;
}

export function flushActivityToRegistry(name: string): void {
    const lastActivity = new Date(lastActivityTime).toISOString();
    updateAgent(name, {
        lastActivity,
        status: computeStatus(lastActivity),
    });
}

export function resetActivity(): void {
    lastActivityTime = Date.now();
    lastAutoStatusTime = 0;
    toolCount = 0;
    currentActivity = "";
}

export function getRegistryDir(): string {
    return REGISTRY_DIR;
}
