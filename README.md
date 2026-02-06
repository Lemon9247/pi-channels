# pi-swarm

Unix socket-based swarm coordination for the [pi coding agent](https://github.com/badlogic/pi-mono). Spawn parallel agents with hive-mind coordination, hierarchical topologies, and live dashboards.

## What It Does

Adds multi-agent swarm support to pi. A queen instance stays interactive while background agents work in parallel, coordinating through a shared hive-mind file and communicating via Unix socket notifications.

**Tools registered:**

| Tool | Available To | Purpose |
|------|-------------|---------|
| `swarm` | Queen, Coordinators | Spawn agents and create socket server |
| `swarm_instruct` | Queen, Coordinators | Send instructions to agents mid-swarm |
| `swarm_status` | Queen, Coordinators | Check current agent status |
| `hive_notify` | Agents, Coordinators | Nudge teammates to check hive-mind |
| `hive_blocker` | Agents, Coordinators | Signal being stuck (interrupts queen) |
| `hive_done` | Agents, Coordinators | Signal task completion |

**Commands:** `/hive [name]`, `/swarm-kill`, `/swarm-stop`

**Skills:** `/swarm` — guides task decomposition, agent setup, and synthesis for both flat and hierarchical topologies.

## Install

```bash
# From local path (development)
pi install /path/to/pi-swarm

# From git
pi install git:github.com/user/pi-swarm

# From npm (when published)
pi install npm:pi-swarm
```

## Topologies

### Flat Swarm

All agents report directly to the queen on one socket. Good for 2-6 agents working on parts of the same problem.

```
Queen (interactive)
├── Agent a1
├── Agent a2
└── Agent a3
```

### Hierarchical Swarm

Coordinators each manage their own agents on separate sockets. Good for independent workstreams that need their own coordination.

```
Queen (interactive)
├── Coordinator A → Agent a1, Agent a2  (alpha socket)
└── Coordinator B → Agent b1, Agent b2  (beta socket)
```

Per-swarm socket isolation is structural — agents in different swarms are on different buses and cannot communicate directly.

## How It Works

1. Queen calls `swarm` tool with agent definitions → agents spawn as background processes → tool returns immediately
2. Queen stays interactive — can chat with user, call other tools, send instructions to agents
3. Agents coordinate through a shared **hive-mind file** (markdown), using the socket as a notification bell
4. Notifications arrive between tool calls: nudges as follow-ups, blockers as interrupts
5. When all agents complete, queen gets a completion notification to synthesize results

### Key Principles

- **Socket = doorbell, hive-mind = state.** The socket carries "I updated the hive-mind" nudges. Complex findings go in the hive-mind file.
- **`edit` not `write` on hive-mind.** Multiple agents share the file. Never overwrite.
- **Agents cannot spawn sub-agents.** Only queens and coordinators get the `swarm` tool. Prevents recursive delegation cascades.
- **Don't `bash sleep` to wait.** The queen stays available for user interaction. Notifications arrive asynchronously.

## Monitoring

- **Widget**: Live agent tree below the editor with status icons and activity preview
- **Status bar**: Compact `🐝 2/3 ⏳1` summary
- **`/hive`**: Print detailed status to chat. `/hive <name>` for a specific agent's activity feed
- **`/swarm-kill`**: Immediately kill the active swarm (process group kill)
- **`/swarm-stop`**: Graceful shutdown — asks agents to wrap up (30s timeout), then kills stragglers

## Architecture

~3900 lines of TypeScript across 16 files:

- `protocol.ts` — JSON-lines message protocol (register, nudge, blocker, done, instruct)
- `server.ts` / `client.ts` — Unix socket server and client
- `state.ts` — Swarm state management, hierarchical codes, relay protocol
- `swarm-tool.ts` — The main `swarm` tool (agent spawning, socket setup, notification handling)
- `instruct-tool.ts` / `status-tool.ts` — Queen's instruction and status tools
- `agent-tools.ts` — Agent-side tools (hive_notify, hive_blocker, hive_done)
- `notifications.ts` — Message injection into pi's context
- `dashboard.ts` — Widget and message rendering
- `activity.ts` — Agent activity tracking
- `agents.ts` — Pre-defined agent discovery
- `swarm-command.ts` — `/hive`, `/swarm-kill`, `/swarm-stop` commands
- `index.ts` — Extension entry point
- `test.ts` — 48 tests

## License

MIT
