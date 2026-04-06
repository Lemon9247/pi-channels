# pi-channels

Inter-session agent communication for the [pi](https://github.com/anthropics/pi) coding agent. Lets independently-running pi sessions talk to each other — no hidden subagents, no task orchestration frameworks. Each pi session is a visible, interactive peer.

## Architecture

```
pi-channels/
├── packages/
│   ├── agent-channels/          # Standalone messaging library (zero pi coupling)
│   │   └── src/
│   │       ├── channel.ts       # Unix socket server, fan-out, history buffer
│   │       ├── client.ts        # Socket client with autoReconnect
│   │       ├── shared-channel.ts # Server-or-client with auto-failover
│   │       ├── mesh.ts          # Multi-channel + DM API (IRC/Discord model)
│   │       ├── group.ts         # Channel lifecycle management
│   │       ├── message.ts       # { msg, data? } format
│   │       ├── framing.ts       # Length-prefixed wire format
│   │       ├── bridge.ts        # Bridge interface
│   │       ├── bridges/tcp.ts   # TCP bridge
│   │       └── util.ts          # allOrCleanup helper
│   │
│   └── pi-channels/             # Pi extension package
│       ├── extensions/channels/
│       │   ├── index.ts         # Extension entry point + lifecycle hooks
│       │   ├── config.ts        # Config loading (global + project)
│       │   ├── registry.ts      # Agent discovery (file-based)
│       │   ├── reservations.ts  # File reservation enforcement
│       │   ├── presence.ts      # Activity tracking + stuck detection
│       │   ├── feed.ts          # Activity feed (JSONL)
│       │   ├── names.ts         # Agent name generation
│       │   ├── terminal.ts      # Terminal spawning
│       │   ├── overlay.ts       # Chat overlay TUI
│       │   ├── tool.ts          # pi_channels tool (16 actions)
│       │   └── types.ts         # Shared types
│       └── tests/
```

## Key Features

- **Mesh networking**: Agents auto-discover each other via SharedChannels with leader election. No central server.
- **Topic channels**: Join/leave named channels like Discord/IRC (`#general`, `#testing`, `#auth-review`).
- **Direct messages**: DM any agent via their inbox socket.
- **File reservations**: Claim files/dirs, get blocked on write conflicts with clear coordination messages.
- **Terminal spawning**: Open new visible terminal windows running pi (tmux, kitty, iTerm, macOS Terminal, Linux).
- **Stuck detection**: Agents idle with open reservations get flagged for peers.
- **Chat overlay**: Ctrl+H opens an interactive TUI with channel filtering, DMs, and message history.
- **Fun names**: Auto-generated names (CozyBadger, FrostyPenguin) from multiple themes.

## Quick Start

1. Enable auto-registration in your project:
   ```json
   // .pi/channels.json
   { "autoRegister": true }
   ```

2. Start multiple pi sessions in the same project — they auto-discover and can communicate.

3. Use the `pi_channels` tool:
   ```
   pi_channels({ action: "send", message: "auth module done" })
   pi_channels({ action: "send", to: "FrostyPenguin", message: "can you review?" })
   pi_channels({ action: "reserve", paths: ["src/auth/"], reason: "Refactoring" })
   pi_channels({ action: "spawn", prompt: "Fix the failing tests" })
   ```

## Commands

- `/channels` — interactive menu
- `/channels chat` — toggle chat overlay
- `/channels status` — quick status
- `/channels config` — show config

## Environment Variables

| Variable | Description |
|----------|-------------|
| `PI_AGENT_NAME` | Override auto-generated agent name |
| `PI_CHANNELS_JOIN` | Comma-separated channels to auto-join on connect |
| `PI_CHANNELS_AUTO_REGISTER` | Set `"1"` to force auto-register regardless of config |
| `PI_CHANNELS_SPAWNED_BY` | Set by parent when spawning — for spawn tracking |

## Config

Global: `~/.pi/agent/channels.json`  
Project: `.pi/channels.json` (overrides global)

| Key | Default | Description |
|-----|---------|-------------|
| `autoRegister` | `false` | Join mesh on session start |
| `autoRegisterPaths` | `[]` | Folders/globs for auto-join |
| `discovery` | `"project"` | `"project"` or `"global"` |
| `nameTheme` | `"creatures"` | creatures/nature/space/minimal/classic/custom |
| `chattiness` | `"normal"` | quiet/normal/verbose |
| `stuckThreshold` | `900` | Seconds before stuck detection |
| `terminal` | `"auto"` | Terminal for spawning |

## Development

```bash
npm install
npm test          # Run all tests (203 total)
npm run test:lib  # agent-channels tests only
npm run test:ext  # pi-channels extension tests only
```

## Philosophy

- **Human as orchestrator** — no agents orchestrating other agents
- **Every session is visible** — no hidden subagents, no `--mode json` workers
- **Cooperative, not enforced** — reservations are cooperative, not locked
- **Library stays general** — agent-channels has zero pi-specific logic
