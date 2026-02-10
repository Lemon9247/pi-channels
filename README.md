# pi-channels

Channel-based messaging and multi-agent coordination for the [pi coding agent](https://github.com/badlogic/pi-mono).

This monorepo contains:

| Package | Description |
|---------|-------------|
| [`agent-channels`](packages/agent-channels/) | Standalone messaging library — channels over Unix domain sockets, fan-out, groups, TCP bridge. Zero pi coupling. |
| [`pi-swarm`](packages/pi-swarm/) | Pi extension — spawn parallel agents with hive-mind coordination, live dashboards, and multi-channel messaging. |

## Architecture

```
┌──────────────────────────────────────────────────────┐
│  Consumers (pi extensions, standalone tools, etc.)   │
│  ┌──────────┐  ┌─────────────────┐                   │
│  │ pi-swarm │  │ pi-bridge-*     │                   │
│  │ (agents) │  │ (tcp, discord,  │                   │
│  │          │  │  matrix, irc)   │                   │
│  └────┬─────┘  └───────┬─────────┘                   │
│       │                │                             │
├───────┴────────────────┴─────────────────────────────┤
│  agent-channels (standalone library)                 │
│                                                      │
│  Channels, fan-out, groups, JSON messages            │
│  Unix domain sockets, filesystem-based addressing    │
└──────────────────────────────────────────────────────┘
```

Channels are sockets. The filesystem is the router. The protocol is just JSON.

## Quick Start

### Use the pi extension

```bash
pi install git:github.com/Lemon9247/pi-channels/packages/pi-swarm
```

Then in pi, use the `swarm` tool to spawn coordinated agents. See the [pi-swarm README](packages/pi-swarm/README.md) for details.

### Use the library standalone

```typescript
import { ChannelGroup, ChannelClient } from "agent-channels";

const group = new ChannelGroup({
    path: "/tmp/my-channels",
    channels: [{ name: "general" }, { name: "alerts" }],
});
await group.start();

const client = new ChannelClient("/tmp/my-channels/general.sock");
await client.connect();
client.on("message", (msg) => console.log(msg));
client.send({ msg: "hello", data: { from: "me" } });
```

See the [agent-channels README](packages/agent-channels/README.md) for the full API.

## Development

```bash
git clone git@github.com:Lemon9247/pi-channels.git
cd pi-channels
npm install
npm run build      # Build agent-channels
npm test           # Run all tests (150 total)
```

Individual test suites:

```bash
npm run test:channels   # agent-channels tests (103)
npm run test:swarm      # pi-swarm tests (47)
```

This is an npm workspace — `agent-channels` is symlinked into `node_modules/` automatically. Changes to the library are immediately visible to pi-swarm without rebuilding.

## Packages

### agent-channels

Standalone Node.js library. No pi dependency. No AI concepts. Just:

- **Channel** — Unix socket server, fans out messages to all connected clients
- **ChannelClient** — connects to a channel, sends and receives
- **ChannelGroup** — directory of channels with lifecycle management
- **Message** — `{ msg: string, data?: Record<string, unknown> }` — that's it
- **TCP Bridge** — expose a channel over TCP for remote connections

### pi-swarm

Pi extension that uses channels to coordinate AI agent swarms:

- **swarm** tool — spawn agents with channel groups (general + per-agent inboxes)
- **hive_notify/blocker/done/progress** — agent coordination tools
- **swarm_instruct/status** — queen management tools
- **Live dashboard** — widget showing agent status, activity, progress
- **Hive-mind** — shared markdown files for persistent coordination

## License

MIT
