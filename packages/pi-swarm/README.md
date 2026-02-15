# pi-swarm

Channel-based swarm coordination for the [pi coding agent](https://github.com/badlogic/pi-mono). Spawn parallel agents with hive-mind coordination, live dashboards, and multi-channel messaging.

## What It Does

Adds multi-agent swarm support to pi. A queen instance stays interactive while background agents work in parallel, coordinating through named channels and a shared hive-mind file.

**Tools:**

| Tool | Available To | Purpose |
|------|-------------|---------|
| `swarm` | Queen, Coordinators | Spawn agents and create channels |
| `swarm_instruct` | Queen, Coordinators | Send message to an agent's inbox |
| `swarm_status` | Queen, Coordinators | Check current agent status |
| `message` | Agents, Coordinators | Send content through channels (coordination, findings, progress) |
| `hive_blocker` | Agents, Coordinators | Signal being stuck (interrupts queen) |
| `hive_done` | Agents, Coordinators | Signal task completion |

**Commands:** `/hive [name]`, `/swarm-kill`, `/swarm-stop`

**Skills:** `/swarm` — guides task decomposition, agent setup, and synthesis.

## Install

```bash
pi install git:github.com/Lemon9247/pi-swarm
```

## How It Works

Each swarm gets a group of Unix socket channels:

```
/tmp/pi-swarm/<swarm-id>/
├── general.sock           # Broadcast — all agents read
├── inbox-queen.sock       # Queen reads — agents send status/blockers
├── inbox-a1.sock          # Agent a1's inbox — queen sends instructions
├── inbox-a2.sock          # Agent a2's inbox
└── group.json             # Channel metadata
```

1. Queen calls `swarm` → channel group created → agents spawn as background processes
2. Agents connect to General and their inbox on startup
3. Agents post findings to General, send completions/blockers to queen's inbox
4. Queen monitors all channels, sends instructions to agent inboxes
5. Hive-mind file provides persistent async coordination alongside real-time channels

### Key Principles

- **Channels are sockets. The filesystem is the router.** No routing code — addressing is "which socket do you write to."
- **One message format.** `{to, msg, data}`. No typed messages or protocol versions.
- **Hierarchy is prompt-guided, not enforced.** A "coordinator" is just an agent whose inbox others are told to use. The protocol doesn't distinguish roles.
- **Hive-mind for persistence, channels for real-time.** Channels carry coordination signals. The hive-mind file is the audit trail.
- **`edit` not `write` on hive-mind.** Multiple agents share the file. Never overwrite.

## Monitoring

- **Widget**: Live agent tree below the editor with status icons and activity preview
- **Status bar**: Compact `🐝 2/3 ⏳1` summary
- **`/hive`**: Print detailed status to chat. `/hive <name>` for a specific agent's activity feed
- **`/swarm-kill`**: Immediately kill the active swarm
- **`/swarm-stop`**: Graceful shutdown (30s timeout, then kill)

## Architecture

Built on [agent-channels](https://github.com/Lemon9247/agent-channels), a standalone channel messaging library over Unix domain sockets. pi-swarm is a thin layer that creates channel groups for swarms and wires agents into them.

```
┌─────────────────────────────────┐
│  pi-swarm (pi extension)        │
│  Swarm lifecycle, tools, UI     │
├─────────────────────────────────┤
│  agent-channels (library)       │
│  Channels, fan-out, framing     │
└─────────────────────────────────┘
```

## Roadmap

pi-swarm is being rebuilt around the channel architecture. The messaging layer is being extracted into [agent-channels](https://github.com/Lemon9247/agent-channels) as a standalone library, and pi-swarm is being rewritten as a thin consumer.

### Phase 1: agent-channels library ← next

Build the standalone channel messaging library. Unix socket channels with fan-out, channel groups, `{to, msg, data}` message format, length-prefixed framing. Zero dependencies, zero pi coupling.

### Phase 2: pi-swarm rewrite

Rewrite pi-swarm internals to use agent-channels. Replace the single-socket server with per-swarm channel groups. Remove protocol-enforced hierarchy — coordinators become agents with known inboxes. Same user-facing tools, completely new internals.

### Phase 3: Prompt architecture

Extract system prompts from code into markdown files. Tool documentation, coordination patterns, channel usage guides. Prompts describe the channel model, not typed messages.

### Phase 4: Bridge interface

Bridge interface in agent-channels + TCP reference bridge. A bridge translates between a local channel and an external system. This makes inter-machine communication (and Discord/Matrix integration) a bridge concern, not a protocol concern. Parallel with Phases 2–3.

```
Wave 1: agent-channels             2-3 sessions
Wave 2: pi-swarm rewrite           2-3 sessions  (bridge in parallel)
Wave 3: Prompt architecture         1-2 sessions
                                    ──────────
Critical path:                      5-8 sessions
```

## Development

Zero npm dependencies — only peer deps on pi's core packages and Node builtins.

```bash
cd extensions/swarm
npx tsx tests/run.ts                                    # all tests
npx tsx tests/core/routing.test.ts                      # single file
```

## License

MIT
