/**
 * Agent Spawning
 *
 * Handles spawning pi agent processes with correct environment variables,
 * system prompts, and process configuration.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createSwarmSystemPrompt } from "./prompts.js";
import { type AgentConfig } from "./agents.js";
import type { AgentFiles } from "./scaffold.js";

export function writePromptToTempFile(name: string, prompt: string): { dir: string; filePath: string } {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-swarm-"));
    const safeName = name.replace(/[^\w.-]+/g, "_");
    const filePath = path.join(tmpDir, `swarm-prompt-${safeName}.md`);
    fs.writeFileSync(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
    return { dir: tmpDir, filePath };
}

export function spawnAgent(
    agentDef: {
        name: string;
        role: string;
        swarm: string;
        task: string;
        agent?: string;
        systemPrompt?: string;
        tools?: string[];
        model?: string;
        cwd?: string;
    },
    socketPath: string,
    taskDirPath: string | undefined,
    defaultCwd: string,
    code: string,
    knownAgents?: Map<string, AgentConfig>,
    agentFiles?: AgentFiles,
): { process: ChildProcess; tmpDir?: string } {
    // Clone to avoid mutating caller's params
    agentDef = { ...agentDef };

    // Pre-defined agent — merge config defaults before building args
    if (agentDef.agent && knownAgents) {
        const agentConfig = knownAgents.get(agentDef.agent);
        if (agentConfig) {
            if (!agentDef.systemPrompt && agentConfig.systemPrompt) {
                agentDef.systemPrompt = agentConfig.systemPrompt;
            }
            if (!agentDef.tools && agentConfig.tools) {
                agentDef.tools = agentConfig.tools;
            }
            if (!agentDef.model && agentConfig.model) {
                agentDef.model = agentConfig.model;
            }
        }
    }

    const args: string[] = ["--mode", "json", "-p", "--no-session"];

    // Model (after merge so pre-defined agent model is available)
    if (agentDef.model) {
        args.push("--model", agentDef.model);
    }

    // Tools
    if (agentDef.tools && agentDef.tools.length > 0) {
        args.push("--tools", agentDef.tools.join(","));
    }

    // System prompt: combine agent-specific + swarm coordination instructions
    let systemPrompt = "";
    if (agentDef.systemPrompt) {
        systemPrompt = agentDef.systemPrompt + "\n\n";
    }
    systemPrompt += createSwarmSystemPrompt(agentDef.name, agentDef.role, agentFiles);

    const { dir: tmpDir, filePath: tmpPromptPath } = writePromptToTempFile(agentDef.name, systemPrompt);
    args.push("--append-system-prompt", tmpPromptPath);

    // Task as the prompt
    args.push(`Task: ${agentDef.task}`);

    // Environment variables for socket connection
    const env: Record<string, string | undefined> = {
        ...process.env,
        PI_SWARM_SOCKET: socketPath,
        PI_SWARM_AGENT_NAME: agentDef.name,
        PI_SWARM_AGENT_ROLE: agentDef.role,
        PI_SWARM_AGENT_SWARM: agentDef.swarm,
        PI_SWARM_CODE: code,
    };

    // Pass task dir to coordinators so they can scaffold subdirectories
    if (taskDirPath && agentDef.role === "coordinator") {
        env.PI_SWARM_TASK_DIR = taskDirPath;
    }

    const proc = spawn("pi", args, {
        cwd: agentDef.cwd || defaultCwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,  // Own process group — enables killing entire subtree
        env,
    });

    // Clean up temp files when process exits
    proc.on("close", () => {
        try {
            fs.unlinkSync(tmpPromptPath);
        } catch { /* ignore */ }
        try {
            fs.rmdirSync(tmpDir);
        } catch { /* ignore */ }
    });

    return { process: proc, tmpDir };
}
