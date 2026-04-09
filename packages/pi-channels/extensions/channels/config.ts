import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type ChannelsConfig, DEFAULT_CONFIG } from "./types.js";

const GLOBAL_CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "channels.json");
const PROJECT_CONFIG_DIR = path.join(os.homedir(), ".pi", "agent", "channels", "projects");
const LEGACY_PROJECT_CONFIG_NAME = path.join(".pi", "channels.json");

export function loadConfig(projectDir?: string): ChannelsConfig {
    const global = readJsonSafe(GLOBAL_CONFIG_PATH);
    validateConfig(global);

    const legacyProject = projectDir
        ? readJsonSafe(path.join(projectDir, LEGACY_PROJECT_CONFIG_NAME))
        : {};
    validateConfig(legacyProject);

    const project = projectDir ? readJsonSafe(projectConfigPath(projectDir)) : {};
    validateConfig(project);

    return { ...DEFAULT_CONFIG, ...global, ...legacyProject, ...project };
}

export function shouldAutoRegister(config: ChannelsConfig, cwd: string): boolean {
    if (config.autoRegister) return true;
    if (process.env.PI_CHANNELS_AUTO_REGISTER === "1") return true;

    const expandedPaths = config.autoRegisterPaths.map((value) => value.replace(/^~/, os.homedir()));

    for (const pattern of expandedPaths) {
        if (pattern.endsWith("/*")) {
            const base = pattern.slice(0, -2);
            if (cwd.startsWith(base)) return true;
        } else if (cwd === pattern || cwd.startsWith(pattern + "/")) {
            return true;
        }
    }

    return false;
}

export function projectConfigPath(projectDir: string): string {
    return path.join(PROJECT_CONFIG_DIR, `${folderHash(projectDir)}.json`);
}

export function folderHash(projectDir: string): string {
    return crypto.createHash("sha256").update(projectDir).digest("hex").slice(0, 12);
}

function readJsonSafe(filepath: string): Record<string, unknown> {
    try {
        const raw = fs.readFileSync(filepath, "utf-8");
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed;
        }
    } catch {
        // Missing file or bad JSON.
    }
    return {};
}

function validateConfig(partial: Record<string, unknown>): void {
    const validKeys = new Set(Object.keys(DEFAULT_CONFIG));
    for (const key of Object.keys(partial)) {
        if (!validKeys.has(key)) {
            console.warn(`[pi-channels] Unknown config key "${key}" — ignoring.`);
        }
    }
}
