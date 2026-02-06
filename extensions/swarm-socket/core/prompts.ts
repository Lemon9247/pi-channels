/**
 * System Prompt Generation
 *
 * Creates system prompts for swarm agents and coordinators.
 * Also handles hive-mind file template creation.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentInfo } from "./state.js";

export function createHiveMindFile(hiveMindPath: string, overview: string | undefined, agents: AgentInfo[]): void {
    // Don't overwrite an existing hive-mind file — a parent swarm may have created it
    if (fs.existsSync(hiveMindPath)) {
        return;
    }

    const title = overview || "Swarm Task";
    const agentList = agents
        .map((a) => `- **${a.name}** (${a.role}, swarm: ${a.swarm}): ${a.task}`)
        .join("\n");
    const statusList = agents.map((a) => `- [ ] ${a.name}`).join("\n");

    const content = `# Hive Mind: ${title}

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

    // Create parent directory if needed
    const dir = path.dirname(hiveMindPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(hiveMindPath, content, "utf-8");
}

export function createSwarmSystemPrompt(hiveMindPath: string | undefined, agentName: string, role: string = "agent"): string {
    const hiveMindSection = hiveMindPath
        ? `The hive-mind file is at: ${hiveMindPath}`
        : "No hive-mind file was specified for this swarm.";

    return `
## Swarm Coordination

You are **${agentName}**, part of a coordinated swarm. You have four coordination tools:

- **hive_notify** — After updating the hive-mind file with findings, call this to nudge your teammates to check it. Include a brief reason. Optional fields: \`to\` (target a specific agent), \`file\`, \`snippet\`, \`section\`, \`tags\` (structured payload so recipients can triage without reading the file).
- **hive_blocker** — If you're stuck on something that affects the swarm, call this immediately. Don't silently spin. Also post in the Blockers section of the hive-mind.
- **hive_done** — When your task is complete, call this with a one-line summary. This should be the LAST thing you do.
- **hive_progress** — Report your current progress (phase, percent, detail). Fire-and-forget. Helps the dashboard and coordinator track what you're doing.

${hiveMindSection}

**Be proactive**: Update the hive-mind early and often. Nudge after every significant finding. When you receive a notification from a teammate, check the hive-mind — they found something that may affect your work.

**Targeted nudges**: Use the \`to\` field on hive_notify to send a nudge only to a specific agent when your finding is relevant to them, not everyone.

**Payload context**: When nudging, include payload fields (\`file\`, \`section\`, \`snippet\`, \`tags\`) so recipients can triage the notification without file I/O. This reduces interruption cost.

**Progress reporting**: Call hive_progress periodically to let the dashboard show what phase you're in. Especially useful before long operations.

**Keep socket messages minimal**: The reason/description/summary fields are short labels. Put detailed findings in the hive-mind file, not in the socket message.

**CRITICAL — Hive-mind file is shared**: Multiple agents write to the same hive-mind file. NEVER use the write tool to overwrite it. ALWAYS use the edit tool to surgically insert your content into the appropriate section. Read the file first to see what others have written, then use edit to add your findings below theirs. If you overwrite the file, you will destroy other agents' work.

**Always call hive_done when finished.** The swarm coordinator is waiting for your completion signal.
${role === "coordinator" ? `
## Coordinator Instructions

You are a **coordinator** — you spawn and manage sub-agents, then synthesize their work.

**Stay responsive**: The queen may send you instructions at any time. Instructions arrive between tool calls, so **never use long sleep commands**. When waiting for agents, poll with \`swarm_status\` every 5-10 seconds. Do NOT use \`bash sleep\` for more than 5 seconds.

**Reply via hive_notify**: Your chat messages do NOT reach the queen. If the queen sends you an instruction asking for information, you MUST respond using \`hive_notify\`. That's the only way your reply reaches the queen.

**Relay instructions down**: If the queen sends an instruction targeting one of your agents, use \`swarm_instruct\` to forward it.

**Sub-agent relays**: When your agents register, complete, or signal blockers, those events are automatically relayed to the queen as first-class relay messages. You don't need to manually forward status updates.

## Peer Communication

You can reach other coordinators directly:
- **hive_notify** broadcasts to all peer coordinators and the queen automatically. Use the \`to\` field to target a specific peer.
- **swarm_instruct** can target a peer coordinator by name. If the target isn't on your local socket, the instruction is routed through the parent socket to reach peers.
` : ""}`;
}
