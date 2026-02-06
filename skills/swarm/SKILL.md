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

For simple, sequential tasks, use the `subagent` tool instead.

## Choosing a Topology

Swarms come in two shapes. Choose based on the task:

### Flat Swarm (2-6 agents, one socket)

Use when all agents work on parts of the same problem and report directly to you.

```
Queen (you, interactive)
├── Agent a1
├── Agent a2
└── Agent a3
```

**Good for**: code review, codebase research, parallel implementation of independent files.

### Hierarchical Swarm (coordinators + agents, per-swarm sockets)

Use when the task has **independent streams** that each need their own coordination — multiple modules, parallel analysis tracks, separate feature branches.

```
Queen (you, interactive)
├── Coordinator A (swarm: alpha)
│   ├── Agent a1  ←─┐
│   └── Agent a2  ←─┴── alpha socket (structural isolation)
└── Coordinator B (swarm: beta)
    ├── Agent b1  ←─┐
    └── Agent b2  ←─┴── beta socket (structural isolation)
```

**Per-swarm socket isolation**: Each coordinator creates its own socket. Agents in swarm A cannot talk to agents in swarm B — they're on different buses. Coordinators talk to each other and the queen on the queen's socket.

**Good for**: multi-module implementation, large analysis with distinct focus areas, separate feature branches.

## How It Works

The `swarm` tool spawns agents as background processes connected via a Unix socket. You (the queen) stay interactive throughout:

1. **You call `swarm`** with agent definitions and an optional hive-mind path → returns immediately
2. **Agents run in background** — you see live status in the widget and get notifications
3. **Use `/hive`** to check detailed agent activity, or **`/hive <name>`** for a specific agent
4. **Use `swarm_status`** for a structured status check
5. **Use `swarm_instruct`** to send instructions to specific agents or entire swarms
6. **When all agents complete**, you get a completion notification with `triggerTurn`
7. **`/swarm-kill`** to immediately kill the swarm, **`/swarm-stop`** for graceful shutdown (30s timeout)

**Do NOT run `bash sleep` to poll or wait for agents.** After launching the swarm, just stop and let notifications come to you. The user can chat with you while agents work — stay available.

### Agent Coordination

Agents coordinate through a **hive-mind file** (shared markdown):
- Agents use `hive_notify` to nudge teammates after updating the hive-mind
- Agents use `hive_blocker` if stuck — this interrupts you (the queen) to help
- Agents use `hive_done` when finished — the last thing they do
- Agents use `edit` (never `write`) on the hive-mind to avoid overwriting each other

The socket is a **notification bell**, not a telephone. Complex state goes in the hive-mind file.

---

## Setup Process

### 1. Create Task Folder

```bash
mkdir -p scratchpad/reports/YYYY-MM-DD-<task-name>/
```

Use a short, descriptive name (kebab-case). For hierarchical swarms, prefix with `multi-`: `YYYY-MM-DD-multi-<task>/`.

### 2. Identify Agents Needed

Determine what specialized agents would help. Common types:
- **Research Agent** — reads docs, gathers context, maps patterns
- **Codebase Agent** — reviews internal code structure
- **Implementation Agent** — writes code
- **Review Agent** — audits code for issues
- **Testing Agent** — writes and runs tests

### 3. Set Up Worktrees (implementation swarms only)

If agents will **modify code** (not just research), create a worktree per agent (flat swarm) or per swarm (hierarchical):

```bash
# Flat swarm: per-agent worktrees
git worktree add ../$(basename $(pwd))-<agent-name> -b swarm/<agent-name>

# Hierarchical swarm: per-swarm worktrees
git worktree add ../$(basename $(pwd))-<swarm-name> -b feature/<swarm-name>

# Copy project-local pi config if it exists
[ -d .pi ] && cp -r .pi ../$(basename $(pwd))-<name>/.pi
```

Pass each agent/coordinator its worktree path via the `cwd` field. **Research-only swarms** skip this — agents that only read and report don't need isolation.

### 4. Write Coordination File (hierarchical only)

For hierarchical swarms, write a coordination file at `scratchpad/reports/YYYY-MM-DD-multi-<task>/coordination.md`:

```markdown
---
tags:
  - type/swarm
---

# Queen's Coordination: [Task Name]
**Date**: YYYY-MM-DD

## Objective
[What the overall task is trying to accomplish]

## Swarms
| Swarm | Coordinator | Worktree | Status |
|-------|-------------|----------|--------|
| alpha | coord-alpha | /path/to/worktree | Pending |
| beta | coord-beta | /path/to/worktree | Pending |

## Agents
| Agent | Swarm | Focus | Status |
|-------|-------|-------|--------|
| a1 | alpha | [focus] | Pending |
| a2 | alpha | [focus] | Pending |
| b1 | beta | [focus] | Pending |

## Cross-Swarm Notes
(Queen posts findings relevant across swarms as coordinators report back)

## Completion Checklist
- [ ] All coordinators complete
- [ ] Cross-swarm synthesis written
- [ ] Branches merged (tests pass after each)
- [ ] Scratchpad committed
```

### 5. Launch the Swarm

Call the `swarm` tool with your agent definitions. **Hive-mind path goes in the scratchpad**, not `/tmp`.

**Flat swarm:**
```
swarm({
  agents: [
    { name: "agent a1", role: "agent", swarm: "alpha", task: "..." },
    { name: "agent a2", role: "agent", swarm: "alpha", task: "..." }
  ],
  hiveMind: {
    path: "scratchpad/reports/YYYY-MM-DD-<task>/hive-mind.md",
    overview: "Task description"
  }
})
```

**Hierarchical swarm:**
```
swarm({
  agents: [
    {
      name: "coord-alpha",
      role: "coordinator",
      swarm: "alpha",
      cwd: "/path/to/worktree-alpha",
      task: "Spawn agents a1 and a2 to work on [tasks]. Synthesize their findings. ..."
    },
    {
      name: "coord-beta",
      role: "coordinator",
      swarm: "beta",
      cwd: "/path/to/worktree-beta",
      task: "Spawn agents b1 and b2 to work on [tasks]. Synthesize their findings. ..."
    }
  ],
  hiveMind: {
    path: "scratchpad/reports/YYYY-MM-DD-multi-<task>/hive-mind.md",
    overview: "Task description"
  }
})
```

The tool returns immediately. Monitor with:
- **Widget** — live status in the sidebar
- **`/hive`** — detailed activity view
- **`swarm_status`** — structured status check
- **`swarm_instruct`** — send instructions to a coordinator or broadcast

---

## Decomposing Tasks Into Agents

Good agent scopes:
- **One area of the codebase** — "Read all files in src/renderer/ and summarize the architecture"
- **One aspect of a problem** — "Find all error handling patterns and assess consistency"
- **One implementation unit** — "Implement the new parser module per the spec"

Bad agent scopes:
- Too broad — "Review the whole project" (give specific directories/files)
- Too narrow — "Fix this one typo" (use `subagent` or do it yourself)
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
2. **Read coordinator reports** (hierarchical) or agent output (flat)
3. **Check for trouble** — blockers, unanswered questions, conflicts between agents/swarms
4. **Write synthesis report**:

For flat swarms: `scratchpad/reports/YYYY-MM-DD-<task>/synthesis.md`
For hierarchical swarms: `scratchpad/reports/YYYY-MM-DD-multi-<task>/cross-swarm-synthesis.md`

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
