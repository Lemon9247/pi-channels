/**
 * Task Directory Scaffolding
 *
 * Creates the layered file structure for swarm coordination.
 * Detects topology (hierarchical vs flat) from agent definitions
 * and creates appropriate directories and template files.
 *
 * Hierarchical (has coordinators):
 *   taskDir/
 *   ├── coordination.md
 *   ├── cross-swarm.md
 *   └── swarm-<name>/          (created later by each coordinator)
 *
 * Flat (agents only):
 *   taskDir/
 *   ├── hive-mind.md
 *   └── <agent-name>-report.md  (created by agents)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentInfo } from "./state.js";

// ─── Types ───────────────────────────────────────────────────────────

export interface AgentFiles {
    reportPath: string;
    hiveMindPath: string;
    crossSwarmPath?: string;   // coordinators in hierarchical only
    synthesisPath?: string;    // coordinators in hierarchical only
}

export interface ScaffoldResult {
    taskDirPath: string;
    isHierarchical: boolean;
    hiveMindPath?: string;           // flat only — shared hive-mind
    coordinationPath?: string;       // hierarchical only
    crossSwarmPath?: string;         // hierarchical only
    agentFiles: Map<string, AgentFiles>;
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Write content to a file only if it doesn't already exist.
 * Creates parent directories as needed.
 * Returns true if the file was written, false if it already existed.
 */
export function writeIfMissing(filePath: string, content: string): boolean {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    if (fs.existsSync(filePath)) {
        return false;
    }
    fs.writeFileSync(filePath, content, "utf-8");
    return true;
}

/**
 * Detect topology from agent definitions.
 * If any agent has role=coordinator, it's hierarchical.
 */
export function detectTopology(agents: AgentInfo[]): "hierarchical" | "flat" {
    return agents.some((a) => a.role === "coordinator") ? "hierarchical" : "flat";
}

/**
 * Sanitize a name for use in file/directory names.
 * Replaces spaces and special chars with hyphens.
 */
function sanitizeName(name: string): string {
    return name.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
}

// ─── Templates ───────────────────────────────────────────────────────

/**
 * Generate the hive-mind.md template for a flat swarm or per-swarm coordination.
 */
export function hiveMindTemplate(overview: string | undefined, agents: AgentInfo[]): string {
    const title = overview || "Swarm Task";
    const agentList = agents
        .map((a) => `- **${a.name}** (${a.role}, swarm: ${a.swarm}): ${a.task}`)
        .join("\n");
    const statusList = agents.map((a) => `- [ ] ${a.name}`).join("\n");

    return `# Hive Mind: ${title}

## Task Overview
${overview || "(No overview provided)"}

## Agents
${agentList}

## Findings
(Agents: add your discoveries here. Be specific — file paths, line numbers, code snippets.)

## Questions
(Post questions here. Check back for answers from other agents.)

## Blockers
(If blocked, post here AND call hive_blocker.)

## Status
${statusList}
`;
}

/**
 * Generate coordination.md for hierarchical swarms.
 * Contains task overview, swarm table, agent table, and completion checklist.
 */
export function coordinationTemplate(overview: string | undefined, agents: AgentInfo[]): string {
    const title = overview || "Swarm Task";

    // Group agents by swarm
    const swarms = new Map<string, AgentInfo[]>();
    for (const agent of agents) {
        if (!swarms.has(agent.swarm)) swarms.set(agent.swarm, []);
        swarms.get(agent.swarm)!.push(agent);
    }

    // Swarm table
    const swarmRows = Array.from(swarms.entries())
        .map(([name, members]) => {
            const coordinator = members.find((m) => m.role === "coordinator");
            const agentCount = members.filter((m) => m.role === "agent").length;
            return `| ${name} | ${coordinator?.name || "(none)"} | ${agentCount} | \`swarm-${sanitizeName(name)}/\` |`;
        })
        .join("\n");

    // Agent table
    const agentRows = agents
        .map((a) => `| ${a.name} | ${a.role} | ${a.swarm} | ${a.task.length > 60 ? a.task.slice(0, 60) + "..." : a.task} |`)
        .join("\n");

    // Completion checklist
    const checklist = agents.map((a) => `- [ ] ${a.name} (${a.role}, ${a.swarm})`).join("\n");

    return `# Coordination: ${title}

## Task Overview
${overview || "(No overview provided)"}

## Swarms

| Swarm | Coordinator | Agents | Directory |
|-------|-------------|--------|-----------|
${swarmRows}

## Agents

| Name | Role | Swarm | Task |
|------|------|-------|------|
${agentRows}

## Completion Checklist
${checklist}
`;
}

/**
 * Generate cross-swarm.md template.
 */
export function crossSwarmTemplate(): string {
    return `# Cross-Swarm Findings

Coordinators: write cross-swarm findings here that affect other swarms.
Use \`edit\` (not \`write\`) to add content — multiple coordinators share this file.

## Findings
(Add cross-swarm discoveries below.)
`;
}

/**
 * Generate synthesis.md template for coordinator subdirectories.
 */
export function synthesisTemplate(swarmName: string): string {
    return `# Synthesis: ${swarmName}

(Coordinator: write your synthesis of agent reports here after all agents complete.)
`;
}

// ─── Scaffolding ─────────────────────────────────────────────────────

/**
 * Scaffold the task directory for a queen-launched swarm.
 * Detects topology and creates appropriate structure.
 */
export function scaffoldTaskDir(
    taskDirPath: string,
    overview: string | undefined,
    agents: AgentInfo[],
): ScaffoldResult {
    const topology = detectTopology(agents);
    const agentFiles = new Map<string, AgentFiles>();

    // Ensure task dir exists
    if (!fs.existsSync(taskDirPath)) {
        fs.mkdirSync(taskDirPath, { recursive: true });
    }

    if (topology === "flat") {
        // Flat: hive-mind.md + agent reports in task dir root
        const hmPath = path.join(taskDirPath, "hive-mind.md");
        writeIfMissing(hmPath, hiveMindTemplate(overview, agents));

        for (const agent of agents) {
            const reportPath = path.join(taskDirPath, `${sanitizeName(agent.name)}-report.md`);
            agentFiles.set(agent.name, {
                reportPath,
                hiveMindPath: hmPath,
            });
        }

        return {
            taskDirPath,
            isHierarchical: false,
            hiveMindPath: hmPath,
            agentFiles,
        };
    } else {
        // Hierarchical: coordination.md + cross-swarm.md + per-swarm subdirs
        const coordPath = path.join(taskDirPath, "coordination.md");
        const csPath = path.join(taskDirPath, "cross-swarm.md");

        writeIfMissing(coordPath, coordinationTemplate(overview, agents));
        writeIfMissing(csPath, crossSwarmTemplate());

        // Group agents by swarm to determine per-swarm structure
        const swarms = new Map<string, AgentInfo[]>();
        for (const agent of agents) {
            if (!swarms.has(agent.swarm)) swarms.set(agent.swarm, []);
            swarms.get(agent.swarm)!.push(agent);
        }

        for (const [swarmName, members] of swarms) {
            const swarmDir = path.join(taskDirPath, `swarm-${sanitizeName(swarmName)}`);

            // Create per-swarm hive-mind (only for agents within this swarm)
            const swarmHmPath = path.join(swarmDir, "hive-mind.md");
            const swarmAgents = members.filter((m) => m.role === "agent");
            writeIfMissing(swarmHmPath, hiveMindTemplate(overview, swarmAgents));

            // Synthesis template
            const synthPath = path.join(swarmDir, "synthesis.md");
            writeIfMissing(synthPath, synthesisTemplate(swarmName));

            for (const agent of members) {
                const reportPath = path.join(swarmDir, `${sanitizeName(agent.name)}-report.md`);
                const files: AgentFiles = {
                    reportPath,
                    hiveMindPath: swarmHmPath,
                };
                if (agent.role === "coordinator") {
                    files.crossSwarmPath = csPath;
                    files.synthesisPath = synthPath;
                }
                agentFiles.set(agent.name, files);
            }
        }

        return {
            taskDirPath,
            isHierarchical: true,
            coordinationPath: coordPath,
            crossSwarmPath: csPath,
            agentFiles,
        };
    }
}

/**
 * Scaffold a coordinator's subdirectory within an existing task dir.
 * Called when a coordinator invokes the swarm tool and has PI_SWARM_TASK_DIR set.
 * Creates swarm-<name>/ under the parent task dir with a flat structure.
 */
export function scaffoldCoordinatorSubDir(
    parentTaskDir: string,
    swarmName: string,
    overview: string | undefined,
    agents: AgentInfo[],
): ScaffoldResult {
    const subDir = path.join(parentTaskDir, `swarm-${sanitizeName(swarmName)}`);
    const hmPath = path.join(subDir, "hive-mind.md");
    const csPath = path.join(parentTaskDir, "cross-swarm.md");
    const synthPath = path.join(subDir, "synthesis.md");

    // Ensure subdirectory exists
    if (!fs.existsSync(subDir)) {
        fs.mkdirSync(subDir, { recursive: true });
    }

    writeIfMissing(hmPath, hiveMindTemplate(overview, agents));
    writeIfMissing(synthPath, synthesisTemplate(swarmName));

    const agentFiles = new Map<string, AgentFiles>();
    for (const agent of agents) {
        const reportPath = path.join(subDir, `${sanitizeName(agent.name)}-report.md`);
        agentFiles.set(agent.name, {
            reportPath,
            hiveMindPath: hmPath,
        });
    }

    return {
        taskDirPath: subDir,
        isHierarchical: false,
        hiveMindPath: hmPath,
        agentFiles,
    };
}
