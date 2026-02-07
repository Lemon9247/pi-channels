# pi-swarm

Unix socket-based swarm coordination for the [pi coding agent](https://github.com/badlogic/pi-mono). Spawn parallel agents with hive-mind coordination, hierarchical topologies, and live dashboards.

## What It Does

Adds multi-agent swarm support to pi. A queen instance stays interactive while background agents work in parallel, coordinating through a shared hive-mind file and communicating via Unix socket notifications.

**Tools:**

| Tool | Available To | Purpose |
|------|-------------|---------|
| `swarm` | Queen, Coordinators | Spawn agents and create socket server |
| `swarm_instruct` | Queen, Coordinators | Send instructions to agents mid-swarm |
| `swarm_status` | Queen, Coordinators | Check current agent status |
| `hive_notify` | Agents, Coordinators | Nudge teammates to check hive-mind |
| `hive_blocker` | Agents, Coordinators | Signal being stuck (interrupts queen) |
| `hive_done` | Agents, Coordinators | Signal task completion |
| `hive_progress` | Agents, Coordinators | Send progress/status updates |

**Commands:** `/hive [name]`, `/swarm-kill`, `/swarm-stop`

**Skills:** `/swarm` — guides task decomposition, agent setup, and synthesis for both flat and hierarchical topologies.

## Install

```bash
pi install git:github.com/Lemon9247/pi-swarm
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
- **Agents cannot spawn sub-agents.** Only queens and coordinators get the `swarm` tool.
- **Don't `bash sleep` to wait.** The queen stays available for user interaction. Notifications arrive asynchronously.

## Monitoring

- **Widget**: Live agent tree below the editor with status icons and activity preview
- **Status bar**: Compact `🐝 2/3 ⏳1` summary
- **`/hive`**: Print detailed status to chat. `/hive <name>` for a specific agent's activity feed
- **`/swarm-kill`**: Immediately kill the active swarm
- **`/swarm-stop`**: Graceful shutdown (30s timeout, then kill)

## Architecture

~4300 source lines, ~3600 test lines, 172 tests across 42 TypeScript files. Organized into four layers:

- **`transport/`** — JSON-lines protocol, Transport/TransportServer interfaces, Unix socket and in-memory implementations
- **`core/`** — Server, client, subject-based router, identity, state management, taskDir scaffolding, process spawning
- **`tools/`** — Pi tool implementations (swarm, instruct, status, agent tools)
- **`ui/`** — Dashboard widget, notifications, activity tracking, commands

Key design: subject-based message routing with pluggable policies, transport abstraction for future TCP support, hierarchical agent codes for tree rendering, generation counter to guard against stale swarm signals.

## Roadmap

### P3: Query/Response Protocol — next

`hive_query` and `hive_respond` tools for agents to ask teammates questions and receive answers via structured socket messages. Async, fire-and-forget.

### P4: Inter-Queen Communication

TCP + mutual TLS for queen-to-queen coordination, local and remote. Auto-discovery on the same machine, explicit config for remote peers. Query routing across queen boundaries, email-style addressing (`agent@queen`). VPN required — never expose to the public internet.

### P5: Prompt Architecture

Extract system prompts from code into markdown files. Tool documentation, coordination patterns, role definitions. Parallel with P4.

## Development

Zero npm dependencies — only peer deps on pi's core packages and Node builtins.

```bash
cd extensions/swarm-socket
npx tsx tests/run.ts                                    # all tests
npx tsx tests/core/routing.test.ts                      # single file
```

## License

MIT
