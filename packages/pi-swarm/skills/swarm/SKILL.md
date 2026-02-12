---
name: swarm
description: Start a multi-agent task with hive-mind coordination for complex research or implementation
argument-hint: [task description]
---

# Multi-Agent Swarm Task

Initialize a swarm of agents to work on: **$ARGUMENTS**

## When to Use Swarms

Use the `swarm` tool when a task benefits from **parallel agents with coordination**:

- **Research**: Multiple agents investigating different parts of a codebase simultaneously
- **Implementation**: Parallel workstreams that touch independent areas
- **Review**: Multiple perspectives on a body of code
- **Analysis**: Different aspects of the same problem examined concurrently

For simple, sequential tasks, use the `swarm` tool in blocking or chain mode instead.

## Choosing a Topology

Swarms come in two shapes. Choose based on the task:

### Flat Swarm (2-6 agents, one channel group)

Use when all agents work on parts of the same problem and report directly to you.

```
Queen (you, interactive)
├── Agent a1
├── Agent a2
└── Agent a3
```

**Good for**: code review, codebase research, parallel implementation of independent files.

### Multi-Team Swarm (sub-teams with topic channels)

Use when the task has **distinct focus areas** that benefit from sub-teams — multiple modules, parallel analysis tracks, separate feature branches.

```
Queen (you, interactive)
│
├── general          ← cross-team coordination, everyone reads
├── topic-frontend   ← team alpha's primary channel
│   ├── Agent a1
│   └── Agent a2
└── topic-backend    ← team beta's primary channel
    ├── Agent b1
    └── Agent b2
```

All agents share the same channel group. Each sub-team has a **topic channel** for their focused work, and the **general channel** is available for cross-team coordination. Agents should prefer their topic channel for day-to-day findings and use general when something affects another team.

**Good for**: multi-module implementation, large analysis with distinct focus areas, separate feature branches.

## How It Works

The `swarm` tool spawns agents as background processes connected via **channels** — Unix sockets with fan-out messaging. Each swarm gets a channel group with a general broadcast channel and per-agent inboxes. You (the queen) stay interactive throughout:

1. **You call `swarm`** with agent definitions and an optional task directory → returns immediately
2. **Agents run in background** — you see live status in the widget and get notifications
3. **Use `/hive`** to check detailed agent activity, or **`/hive <name>`** for a specific agent
4. **Use `swarm_status`** for a structured status check
5. **Use `swarm_instruct`** to send instructions to specific agents or entire swarms
6. **When all agents complete**, you get a completion notification with `triggerTurn`
7. **`/swarm-kill`** to immediately kill the swarm, **`/swarm-stop`** for graceful shutdown (30s timeout)

**Do NOT run `bash sleep` to poll or wait for agents.** After launching the swarm, just stop and let notifications come to you. The user can chat with you while agents work — stay available.

### Agent Coordination

Agents coordinate through two mechanisms:

**Channels** (real-time notifications):
- `hive_notify` — nudge teammates after updating the hive-mind
- `hive_blocker` — signal a blocker (interrupts the queen to help)
- `hive_done` — signal task completion (the last thing an agent does)
- `hive_progress` — report progress to the dashboard

**Hive-mind file** (persistent shared state):
- A shared markdown file where agents write detailed findings
- Agents use `edit` (never `write`) on the hive-mind to avoid overwriting each other
- Channels are the notification bell; the hive-mind is the shared memory

---

## Setup Process

### 1. Create Task Folder

```bash
mkdir -p scratchpad/reports/YYYY-MM-DD-<task-name>/
```

Use a short, descriptive name (kebab-case).

### 2. Identify Agents Needed

Determine what specialized agents would help. Common types:
- **Research Agent** — reads docs, gathers context, maps patterns
- **Codebase Agent** — reviews internal code structure
- **Implementation Agent** — writes code
- **Review Agent** — audits code for issues
- **Testing Agent** — writes and runs tests

### 3. Set Up Worktrees (implementation swarms only)

If agents will **modify code** (not just research), create a worktree per agent or per team:

```bash
# Per-agent worktrees
git worktree add ../$(basename $(pwd))-<agent-name> -b swarm/<agent-name>

# Per-team worktrees (agents on same team share a worktree)
git worktree add ../$(basename $(pwd))-<team-name> -b feature/<team-name>

# Copy project-local pi config if it exists
[ -d .pi ] && cp -r .pi ../$(basename $(pwd))-<name>/.pi
```

Pass each agent its worktree path via the `cwd` field. **Research-only swarms** skip this — agents that only read and report don't need isolation.

### 4. Launch the Swarm

Call the `swarm` tool with your agent definitions. **Task directory goes in the scratchpad**, not `/tmp`.

**Flat swarm:**
```
swarm({
  agents: [
    { name: "agent a1", role: "agent", swarm: "alpha", task: "..." },
    { name: "agent a2", role: "agent", swarm: "alpha", task: "..." }
  ],
  taskDir: {
    path: "scratchpad/reports/YYYY-MM-DD-<task>/",
    overview: "Task description"
  }
})
```

**Multi-team swarm:**
```
swarm({
  agents: [
    { name: "agent a1", role: "agent", swarm: "frontend", task: "..." },
    { name: "agent a2", role: "agent", swarm: "frontend", task: "..." },
    { name: "agent b1", role: "agent", swarm: "backend", task: "..." },
    { name: "agent b2", role: "agent", swarm: "backend", task: "..." }
  ],
  taskDir: {
    path: "scratchpad/reports/YYYY-MM-DD-<task>/",
    overview: "Task description"
  }
})
```

Agents in the same `swarm` form a sub-team. They share the general channel for cross-team visibility but should prefer their topic channel for focused work.

The tool returns immediately. Monitor with:
- **Widget** — live status in the sidebar
- **`/hive`** — detailed activity view
- **`swarm_status`** — structured status check
- **`swarm_instruct`** — send instructions to a coordinator or broadcast

### Task Directory Scaffolding

The `swarm` tool automatically scaffolds the task directory:

**Flat swarm** creates:
```
taskDir/
├── hive-mind.md         (shared state, all agents read/write)
└── <agent-name>-report.md  (per-agent, write tool OK)
```

Agents receive their file paths in their system prompt. No manual file creation needed.

---

## Decomposing Tasks Into Agents

Good agent scopes:
- **One area of the codebase** — "Read all files in src/renderer/ and summarize the architecture"
- **One aspect of a problem** — "Find all error handling patterns and assess consistency"
- **One implementation unit** — "Implement the new parser module per the spec"

Bad agent scopes:
- Too broad — "Review the whole project" (give specific directories/files)
- Too narrow — "Fix this one typo" (use blocking mode or do it yourself)
- Overlapping — two agents modifying the same files (use worktrees or assign distinct files)

Agent count guidelines:
| Task Type | Agents | Notes |
|-----------|--------|-------|
| Quick research | 2-3 | Different perspectives on same codebase |
| Thorough review | 3-5 | Split by module/concern |
| Parallel implementation | 2-4 | Split by independent workstreams |
| Large analysis | 4-6 | Split by subsystem |

## Agent Naming

Use consistent naming: `agent <swarm><number>` — e.g., `agent a1`, `agent a2`, `agent b1`.

For pre-defined agents, use the `agent` field to reference an agent file from `~/.pi/agent/agents/`:
```json
{ "name": "agent a1", "role": "agent", "swarm": "alpha", "agent": "scout", "task": "..." }
```
The agent file's system prompt, tools, and model are used as defaults (inline params override).

---

## After Completion

### Synthesize

1. **Read the hive-mind** — it has the combined findings from all agents
2. **Read agent reports** for each agent's detailed findings
3. **Check for trouble** — blockers, unanswered questions, conflicts between teams
4. **Write synthesis report** at `scratchpad/reports/YYYY-MM-DD-<task>/synthesis.md`

### Merge Worktrees (if created)

Merge in dependency order, smallest/most independent first:

```bash
git checkout main
git merge --no-ff <branch> -m "Merge <name>: <summary>"
```

**Run tests after each merge.** Stop on failure, fix or escalate to user.

### Cleanup

1. **Remove worktrees** (ask user first):
   ```bash
   git worktree remove ../$(basename $(pwd))-<name>
   git branch -d <branch>
   ```
2. **Update index files**: Add the swarm entry to `scratchpad/reports/00-index.md` with wiki-links
3. **Commit scratchpad**: `cd scratchpad && git add . && git commit -m "Add swarm reports: <task>" && git push && cd ..`

---

## Synthesis Report Template

```markdown
---
tags:
  - type/report
---

# [Task Name] — Synthesis Report

**Date**: YYYY-MM-DD
**Task**: [Description]

---

## Executive Summary
[3-5 sentence summary of findings and recommendations]

## Findings by Agent

### [Agent 1 Name]: [Focus Area]
[Synthesized findings]

### [Agent 2 Name]: [Focus Area]
[Synthesized findings]

## Recommendations
1. [Key recommendation]
2. [Key recommendation]

## Next Steps
- [ ] Action item 1
- [ ] Action item 2

## Sources
- [[Project/reports/YYYY-MM-DD-task/hive-mind|Hive Mind]]

## Related
- [[Project/00-index|Project Index]]
- [[Project/reports/00-index|Reports Index]]
```
