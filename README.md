# agent-channels

Channel-based messaging over Unix domain sockets. Simple, protocol-agnostic, zero dependencies.

## Status

**Pre-release — API design phase.** Not yet published.

## What It Is

A Node.js library for multi-channel messaging over Unix domain sockets. Create named channels, connect clients, fan out messages. One JSON message format for everything.

```
/tmp/channels/my-group/
├── general.sock
├── topic-research.sock
├── inbox-a1.sock
├── inbox-a2.sock
└── group.json
```

Any process on the machine can connect to any channel. Messages fan out to all connected clients. The library handles framing, fan-out, lifecycle, and cleanup. It does **not** handle authentication, encryption, networking, or application semantics.

## Message Format

```json
{
    "to": "general",
    "msg": "Found the bug — it's a race condition in the frame decoder",
    "data": {
        "file": "src/framing.ts",
        "line": 42
    }
}
```

- **`to`** — addressing hint (who/what this is for)
- **`msg`** — human-readable content
- **`data`** — optional structured payload, consumer-defined

The library validates shape but doesn't interpret content. `to` is a pass-through — the library fans out everything regardless. Consumers filter on the receiving end if they want.

## Concepts

- **Channel** — a Unix socket server. Clients connect. When one client sends a message, all other connected clients receive it (fan-out). Sender is excluded by default.
- **Inbox** — semantically a single-reader channel. Mechanically identical. The distinction is a hint, not an enforcement.
- **ChannelGroup** — a directory of channels with lifecycle management. Create the group, start all channels, stop all channels, clean up.
- **Bridge** — translates between a local channel and an external system (TCP, Discord, Matrix, etc.). The library includes a TCP bridge; others are separate packages.

## Planned API

```typescript
import { Channel, ChannelClient, ChannelGroup } from "agent-channels";

// Server side — create a group of channels
const group = new ChannelGroup({
    path: "/tmp/channels/my-group",
    channels: [
        { name: "general" },
        { name: "inbox-a1", inbox: true },
        { name: "inbox-a2", inbox: true },
    ],
});
await group.start();

// Client side — connect and communicate
const client = new ChannelClient("/tmp/channels/my-group/general.sock");
await client.connect();

client.on("message", (msg) => {
    console.log(`${msg.to}: ${msg.msg}`);
});

client.send({ to: "general", msg: "hello from a1", data: { status: "ready" } });
```

## Design Principles

- **Zero dependencies.** Node.js builtins only (`net`, `fs`, `path`, `events`).
- **Protocol-agnostic.** No opinions about what messages mean. No AI, no agents, no frameworks.
- **Filesystem is the router.** Channels are sockets in a directory. Addressing is "which socket do you write to." No routing code.
- **One message format.** `{to, msg, data}`. No typed messages, no protocol versioning, no schema enforcement on `data`.
- **Bridges for external systems.** TCP, Discord, Matrix — each is a bridge that translates between local channels and an external protocol. The library ships a TCP bridge; others are separate packages.

## License

MIT
