# pi-channels

Inter-session communication for the [pi](https://github.com/mariozechner/pi-coding-agent) coding agent.

The design is deliberately simple:
- **agent-channels** provides one primitive: a failover-capable `Channel`
- **Mesh** groups channels inside one socket directory
- **pi-channels** adds discovery, reservations, terminal spawning, `/channels`, and the status bar widget

No hidden subagents. No orchestrator layer. Just visible pi sessions talking to each other.

## Architecture

```text
pi-channels/
├── packages/
│   ├── agent-channels/
│   │   └── src/
│   │       ├── channel.ts       # Shared server/client channel with promotion
│   │       ├── mesh.ts          # Channel group + DM convenience
│   │       ├── message.ts       # { msg, data? } format
│   │       ├── framing.ts       # Length-prefixed wire format
│   │       └── index.ts         # Public exports
│   │
│   └── pi-channels/
│       └── extensions/channels/
│           ├── index.ts         # Extension entry point + lifecycle hooks
│           ├── config.ts        # Config loading (global + per-project hash)
│           ├── registry.ts      # Agent discovery + local activity tracking
│           ├── reservations.ts  # Cooperative file reservations
│           ├── names.ts         # Agent name generation
│           ├── terminal.ts      # Terminal spawning
│           ├── overlay.ts       # Overlay state helpers
│           ├── channels-overlay.ts # Interactive TUI overlay
│           ├── tool.ts          # msg / agent / channel / reserve tools
│           └── types.ts         # Shared types
```

## Key Features

- **Mesh networking**: sessions auto-discover each other via shared Unix sockets
- **Topic channels**: join and leave named channels like `#general` or `#testing`
- **Direct messages**: each agent has a private DM inbox channel under the same channel model
- **File reservations**: cooperative write protection with clear conflict messages
- **Terminal spawning**: open a new visible terminal window running pi
- **Chat overlay**: `/channels` and `Ctrl+H` open the interactive TUI
- **Status bar widget**: quick name / peer / unread indicator in pi
- **Fun names**: auto-generated names like `SwiftKoala` and `BoldHare`

## Quick Start

Start multiple pi sessions in the same project. They auto-register by default.

Use the tools directly:

```js
msg({ message: "auth module done" })
msg({ to: "BoldHare", message: "can you review?" })
reserve({ paths: ["src/auth/"], reason: "Refactoring" })
agent({ action: "spawn", prompt: "Fix the failing tests" })
channel({ action: "join", name: "testing" })
```

## Commands

- `/channels` — interactive menu
- `Ctrl+H` — open the chat overlay directly

## Environment Variables

| Variable | Description |
|----------|-------------|
| `PI_AGENT_NAME` | Override auto-generated agent name |
| `PI_CHANNELS_JOIN` | Comma-separated channels to auto-join on connect |
| `PI_CHANNELS_AUTO_REGISTER` | Set `"1"` to force auto-register regardless of config |
| `PI_CHANNELS_SPAWNED_BY` | Set by parent when spawning a new session |

## Config

Global config lives at:
- `~/.pi/agent/channels.json`

Per-project overrides live at:
- `~/.pi/agent/channels/projects/<project-hash>.json`

Legacy `.pi/channels.json` files are still read if present, but new config is not written into project folders anymore.

| Key | Default | Description |
|-----|---------|-------------|
| `autoRegister` | `true` | Join the mesh on session start |
| `autoRegisterPaths` | `[]` | Folders/globs to auto-register when `autoRegister` is false |
| `nameTheme` | `"creatures"` | creatures / nature / space / minimal / classic / custom |
| `chattiness` | `"normal"` | quiet / normal / verbose |
| `terminal` | `"auto"` | Terminal preference for spawning |
| `autoJoinChannels` | `["general"]` | Extra channels to join automatically |

## Development

```bash
npm install
npm test          # Run all tests
npm run test:lib  # agent-channels only
npm run test:ext  # extension only
npm run build     # rebuild agent-channels dist output
```

## Philosophy

- **Human as orchestrator** — no agent swarm nonsense
- **Every session is visible** — no hidden workers
- **Cooperative, not enforced** — reservations are social, not hard locks
- **One core primitive** — channels everywhere, not a pile of special cases
