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
5. **Use `swarm_add`** to add more agents to the running swarm if needed
6. **Use `swarm_kill`** to terminate a specific agent (recursive — kills sub-agents too)
7. **When agents complete**, they call `hive_done` — you get a notification

**Do NOT `bash sleep` to wait.** After launching, just stop — notifications arrive automatically. Stay available to chat with the user.

## Available Tools

| Tool | Purpose |
|------|---------|
| `swarm` | Start a new swarm with agent definitions |
| `swarm_add` | Add agents to a **running** swarm mid-flight |
| `swarm_status` | Check agent statuses (tree view with sub-agents) |
| `swarm_instruct` | Send instructions to agents, swarms, or broadcast |
| `swarm_kill` | Kill a specific agent + its sub-agents |

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

**Adding agents mid-swarm** (need more parallelism, a replacement, or a new direction):
```typescript
swarm_add({
  agents: [
    { name: "extra-scout", role: "agent", swarm: "frontend", agent: "scout", task: "Search for accessibility issues in UI components" }
  ]
})
```
New agents join the existing channels, appear in the dashboard, and can message/be messaged by other agents. Existing agents are notified via an `agent_added` broadcast on the general channel.

**Worktrees** (optional): For implementation swarms where agents modify code, use git worktrees to isolate changes. Create with `git worktree add ../pi-channels-<name> -b swarm/<name>`, then pass `cwd` to each agent. Research swarms skip this.

## Sub-Agents and Hierarchy

Agents with `canSpawn: true` can launch their own sub-swarms. Sub-agent status is automatically relayed to the queen and rendered as a nested tree in the dashboard:

```
🐝 Swarm — 1/2 complete
   ├ ⏳ coordinator (worker/sonnet-4-5)  spawning sub-swarm
   │  ├ ✅ sub-scout-1 (scout/haiku-4-5)  mapped files
   │  └ ⏳ sub-scout-2 (scout/haiku-4-5)  reading...
   └ ✅ agent-1 (scout/haiku-4-5)  done
```

Key behaviors:
- **Sub-agents don't block swarm completion** — only direct agents determine when `onAllDone` fires
- **`swarm_kill` is recursive** — killing a coordinator also kills its sub-agents
- **Relay is automatic** — no LLM involvement needed, coordinators relay at the framework level
- **Arbitrary nesting depth** — a coordinator's sub-agent can itself be a coordinator with its own sub-agents

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
- **Never read code** — spawn reviewer agents for quality checks

**Quality gating:**
- Spawn a reviewer agent to check implementation agents' work
- Read the reviewer's structured summary (not code)
- Decide pass/fail: if pass, move on; if fail, forward feedback via `swarm_instruct`
