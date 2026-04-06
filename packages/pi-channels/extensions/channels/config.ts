import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { type ChannelsConfig, DEFAULT_CONFIG } from "./types.js";

const GLOBAL_CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "channels.json");
const PROJECT_CONFIG_NAME = path.join(".pi", "channels.json");

/**
 * Load config with project overriding global overriding defaults.
 */
export function loadConfig(projectDir?: string): ChannelsConfig {
    const global = readJsonSafe(GLOBAL_CONFIG_PATH);
    const project = projectDir ? readJsonSafe(path.join(projectDir, PROJECT_CONFIG_NAME)) : {};
    return { ...DEFAULT_CONFIG, ...global, ...project };
}

/**
 * Save a key/value pair to project config (or global if no projectDir).
 */
export function saveConfigValue(
    key: string,
    value: unknown,
    projectDir?: string,
): void {
    const configPath = projectDir
        ? path.join(projectDir, PROJECT_CONFIG_NAME)
        : GLOBAL_CONFIG_PATH;

    const existing = readJsonSafe(configPath);
    (existing as Record<string, unknown>)[key] = value;

    const dir = path.dirname(configPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(existing, null, 2) + "\n");
}

/**
 * Check if auto-registration should be enabled for the given cwd.
 */
export function shouldAutoRegister(config: ChannelsConfig, cwd: string): boolean {
    if (config.autoRegister) return true;
    if (process.env.PI_CHANNELS_AUTO_REGISTER === "1") return true;

    const expandedPaths = config.autoRegisterPaths.map((p) =>
        p.replace(/^~/, os.homedir()),
    );

    for (const pattern of expandedPaths) {
        // Simple glob: trailing /* matches any subdirectory
        if (pattern.endsWith("/*")) {
            const base = pattern.slice(0, -2);
            if (cwd.startsWith(base)) return true;
        } else if (cwd === pattern || cwd.startsWith(pattern + "/")) {
            return true;
        }
    }

    return false;
}

function readJsonSafe(filepath: string): Record<string, unknown> {
    try {
        const raw = fs.readFileSync(filepath, "utf-8");
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed;
        }
    } catch {
        // File doesn't exist or invalid JSON
    }
    return {};
}
