# agent-channels

Channel-based messaging over Unix domain sockets. Simple, protocol-agnostic, zero runtime dependencies.

## Install

```bash
npm install agent-channels
```

Requires Node.js 20+.

## Quick Start

```typescript
import { Channel, ChannelClient, ChannelGroup } from "agent-channels";

// Create a group of channels
const group = new ChannelGroup({
    path: "/tmp/channels/my-group",
    channels: [
        { name: "general" },
        { name: "inbox-a1", inbox: true },
        { name: "inbox-a2", inbox: true },
    ],
});
await group.start();

// Connect a client
const client = new ChannelClient("/tmp/channels/my-group/general.sock");
await client.connect();

client.on("message", (msg) => {
    console.log(`[${msg.to}] ${msg.msg}`);
});

client.send({ to: "general", msg: "hello from a1", data: { status: "ready" } });
```

## Concepts

### Channels

A **Channel** is a Unix domain socket server. Clients connect to it. When one client sends a message, all other connected clients receive it (fan-out). The sender is excluded by default.

```
/tmp/channels/my-group/
├── general.sock         # Broadcast channel
├── topic-research.sock  # Topic channel
├── inbox-a1.sock        # Agent a1's inbox
├── inbox-a2.sock        # Agent a2's inbox
└── group.json           # Discovery metadata
```

### Messages

One format for everything:

```typescript
interface Message {
    to: string;                      // Addressing hint — who/what this is for
    msg: string;                     // Human-readable content
    data?: Record<string, unknown>;  // Optional structured payload
}
```

The `to` field is an **addressing hint**, not a routing directive. The library fans out every message to all connected clients regardless of `to`. Consumers use `to` to filter on the receiving end if they want.

Both `to` and `msg` must be non-empty strings. `data`, if present, must be a plain object. The library validates shape but does not interpret content.

### Inboxes

An **inbox** is a channel with a single intended reader. Mechanically identical to any other channel — the distinction is semantic, stored in `group.json` as a hint. The library does not enforce single-reader access.

### Channel Groups

A **ChannelGroup** manages a directory of channels: creates the directory, starts all channels, writes `group.json` metadata, and handles teardown. `group.json` is written **after** all channels are listening, so any process reading it can trust that listed channels are ready.

### Wire Format

Messages are length-prefixed JSON over the socket:

```
[4 bytes: uint32 BE payload length][N bytes: UTF-8 JSON]
```

Maximum message size: 16 MB (configurable). The `FrameDecoder` handles partial reads and multi-message chunks.

## API

### `Channel`

```typescript
import { Channel } from "agent-channels";

const channel = new Channel({
    path: "/tmp/my-channel.sock",
    echoToSender: false,  // default: don't echo back to sender
});

await channel.start();

channel.on("message", (msg, clientId) => { /* client sent a message */ });
channel.on("connect", (clientId) => { /* client connected */ });
channel.on("disconnect", (clientId) => { /* client disconnected */ });
channel.on("error", (err) => { /* server or client error */ });

channel.broadcast({ to: "all", msg: "from the server" });  // to everyone
console.log(channel.clientCount);  // number of connected clients
console.log(channel.started);      // whether listening
console.log(channel.path);         // socket path

await channel.stop();  // disconnect all, unlink socket
```

**Stale socket detection:** On `start()`, if the socket file already exists, the channel tries to connect. If nothing is listening (ECONNREFUSED), it's stale — removed and replaced. If something is listening, throws `"Socket already in use"`.

### `ChannelClient`

```typescript
import { ChannelClient } from "agent-channels";

const client = new ChannelClient("/tmp/my-channel.sock");
await client.connect();

client.on("message", (msg) => { /* received a message */ });
client.on("connect", () => { /* connected */ });
client.on("disconnect", () => { /* connection lost */ });
client.on("error", (err) => { /* error */ });

client.send({ to: "general", msg: "hello" });
console.log(client.connected);  // true

client.disconnect();
```

No auto-reconnect. If the connection drops, `"disconnect"` fires and the consumer can reconnect manually (`disconnect()` then `connect()` again).

### `ChannelGroup`

```typescript
import { ChannelGroup } from "agent-channels";

const group = new ChannelGroup({
    path: "/tmp/channels/my-group",
    channels: [
        { name: "general" },
        { name: "topic-research" },
        { name: "inbox-a1", inbox: true },
    ],
});

await group.start();  // creates dir, starts all channels, writes group.json

group.list();               // ["general", "topic-research", "inbox-a1"]
group.channel("general");   // returns the Channel instance

// Add a channel at runtime
await group.addChannel({ name: "topic-new" });

await group.stop();                    // stop channels, remove sockets + group.json
await group.stop({ removeDir: true }); // also remove the directory
```

**`group.json`** written on start (and updated on `addChannel`):

```json
{
    "created": "2026-02-07T18:00:00.000Z",
    "pid": 12345,
    "channels": [
        { "name": "general" },
        { "name": "topic-research" },
        { "name": "inbox-a1", "inbox": true }
    ]
}
```

### `encode` / `FrameDecoder`

Low-level framing utilities, exposed for custom transport implementations:

```typescript
import { encode, FrameDecoder } from "agent-channels";

const frame = encode({ to: "x", msg: "hello" });  // Buffer

const decoder = new FrameDecoder(16 * 1024 * 1024);  // max message size
const messages = decoder.push(chunk);  // returns Message[]
decoder.reset();  // clear internal buffer
```

### `isValidMessage`

```typescript
import { isValidMessage } from "agent-channels";

isValidMessage({ to: "a", msg: "b" });              // true
isValidMessage({ to: "", msg: "b" });                // false (empty to)
isValidMessage({ to: "a", msg: "b", data: [1] });   // false (data must be object)
```

## Design Principles

- **Zero runtime dependencies.** Node.js builtins only (`net`, `fs`, `path`, `events`).
- **Protocol-agnostic.** No opinions about what messages mean. No routing logic.
- **Filesystem is the router.** Channels are sockets in a directory. Addressing is "which socket do you connect to."
- **One message format.** `{to, msg, data}`. No typed messages, no schema enforcement on `data`.
- **No networking.** Unix sockets only. Use bridges for TCP, WebSocket, etc.

## What It Doesn't Do

- **Authentication.** Anyone on the machine can connect to any socket.
- **Encryption.** Messages are plaintext.
- **Routing.** Fan-out only. The library doesn't route based on `to`.
- **Auto-reconnect.** Consumers handle reconnection.
- **Backpressure.** OS socket buffers handle it. If a client falls behind, it was probably dead.

## License

MIT
