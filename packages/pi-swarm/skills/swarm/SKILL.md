---
name: swarm
description: Start a multi-agent task with hive-mind coordination for complex research or implementation
argument-hint: [task description]
---

# Multi-Agent Swarm Task

Initialize a swarm of agents to work on: **$ARGUMENTS**

## When to Use Swarms

Use swarms for tasks that benefit from **parallel agents with coordination**: research across multiple areas, parallel implementation of independent workstreams, multi-perspective code review, or large-scale analysis.

For simple, sequential tasks, just do it yourself — no swarm needed.

## How It Works

The `swarm` tool spawns agents as background processes connected via channels (Unix sockets with fan-out messaging). You (the queen) stay interactive throughout:

1. **Call `swarm`** with agent definitions and task directory → returns immediately
2. **Agents run in background** — you see live status in the widget and get notifications
3. **Use `/hive`** for detailed agent activity, **`swarm_status`** for structured status
4. **Use `swarm_instruct`** to send instructions to agents mid-swarm
5. **When agents complete**, they go **idle** — re-task with new work or dismiss

**Do NOT `bash sleep` to wait.** After launching, just stop — notifications arrive automatically. Stay available to chat with the user.

## Agent Types

| Agent | Model | Purpose | Modifies Code? |
|-------|-------|---------|----------------|
| **scout** | claude-haiku-4-5 | Fast codebase recon — grep, read, return structured findings | No (read-only) |
| **planner** | claude-sonnet-4-5 | Analyze requirements, produce implementation plans | No (read-only) |
| **worker** | claude-sonnet-4-5 | General implementation — full tool access | Yes |
| **reviewer** | claude-sonnet-4-5 | Code review — analyze diffs, flag issues | No (read-only) |

Use the `agent` field in agent definitions to reference these pre-defined agents.

## Launching a Swarm

Task directories go in the scratchpad: `scratchpad/reports/YYYY-MM-DD-<task>/`. The tool scaffolds the directory automatically (hive-mind and per-agent report files).

**Flat swarm** (2-6 agents, all report directly to you):
```typescript
swarm({
  agents: [
    { name: "agent a1", role: "agent", swarm: "alpha", agent: "scout", task: "Read src/core/ and map architecture" },
    { name: "agent a2", role: "agent", swarm: "alpha", agent: "scout", task: "Read src/ui/ and document patterns" }
  ],
  taskDir: {
    path: "scratchpad/reports/2026-02-27-codebase-review/",
    overview: "Full codebase architecture review"
  }
})
```

**Multi-team swarm** (distinct focus areas, each team has a topic channel):
```typescript
swarm({
  agents: [
    { name: "agent a1", role: "agent", swarm: "frontend", agent: "worker", task: "Implement UI components", cwd: "../pi-channels-frontend" },
    { name: "agent a2", role: "agent", swarm: "frontend", agent: "worker", task: "Write UI tests" },
    { name: "agent b1", role: "agent", swarm: "backend", agent: "worker", task: "Implement API layer", cwd: "../pi-channels-backend" },
    { name: "agent b2", role: "agent", swarm: "backend", agent: "worker", task: "Write integration tests" }
  ],
  taskDir: { path: "scratchpad/reports/2026-02-27-parallel-impl/", overview: "Parallel frontend/backend work" }
})
```

**Worktrees** (optional): For implementation swarms where agents modify code, use git worktrees to isolate changes. Create with `git worktree add ../pi-channels-<name> -b swarm/<name>`, then pass `cwd` to each agent. Research swarms skip this.

## After Completion

1. **Read the hive-mind** for combined findings across all agents
2. **Read agent reports** for detailed per-agent work
3. **Write a synthesis** at `scratchpad/reports/YYYY-MM-DD-<task>/synthesis.md`
4. **Merge worktrees** if created (test after each merge)
5. **Commit scratchpad**: `cd scratchpad && git add . && git commit -m "..." && git push && cd ..`

## Coordination Model

**Agents self-coordinate via channels:**
- Announce what area/files you're claiming via `message` as your first action
- Listen to other agents' messages and adjust if there's overlap
- Negotiate conflicts via `message` — don't wait for the queen to mediate
- Read the plan file (if present) for broader context on what needs doing

**Queen orchestrates (you):**
- Spawn agents with rough scopes (areas, not file assignments)
- Monitor and relay user intent via `swarm_instruct`
- Re-task idle agents with follow-up work or dismiss when done
- **Never read code** — spawn reviewer agents for quality checks

**Quality gating:**
- Spawn a reviewer agent to check implementation agents' work
- Read the reviewer's structured summary (not code)
- Decide pass/fail: if pass, dismiss or re-task; if fail, forward feedback via `swarm_instruct`

## Re-Tasking Idle Agents

When an agent calls `hive_done`, it goes **idle** — stays alive, keeps context, waits for instructions. You can:

- **Re-task**: Send new work via `swarm_instruct("agent-name", "New task: ...")` — agent resumes with full prior context
- **Dismiss**: Send `swarm_instruct("agent-name", "You are dismissed. Exit now.")` — agent exits

Prefer re-tasking over spawning fresh agents when follow-up work is related. Dismiss agents you won't need again to free resources.
