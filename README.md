# agent-channels

Channel-based messaging over Unix domain sockets. Simple, protocol-agnostic, zero runtime dependencies.

## What is this for

Agent-Channels is a simple protocol to be used by agents, to let them talk to other agents on your machine. It's modelled after IRC/matrix/discord etc. and is really nothing fancy - just a bunch of JSON through IPC. Clients can subscribe to receive messages on different sockets, and send them as well. Also includes a really simple reference TCP bridge later so you can communicate over networks.

Honestly it's dumb as rocks, but it's simple and easy :)


## Install

```bash
git clone git@github.com:Lemon9247/agent-channels.git
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
        { name: "inbox-a1" },
        { name: "inbox-a2" },
    ],
});
await group.start();

// Connect a client
const client = new ChannelClient("/tmp/channels/my-group/general.sock");
await client.connect();

client.on("message", (msg) => {
    console.log(msg.msg);
});

client.send({ msg: "hello from a1", data: { from: "a1", status: "ready" } });
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
    msg: string;                     // Human-readable content
    data?: Record<string, unknown>;  // Optional structured payload
}
```

`msg` must be a non-empty string. `data`, if present, must be a plain object. The library validates shape but does not interpret content — use `data` for any metadata you need (sender identity, message type, addressing, etc.).

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

channel.broadcast({ msg: "announcement from the server" });  // to everyone
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

client.send({ msg: "hello" });
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
        { name: "inbox-a1" },
    ],
});

await group.start();  // creates dir, starts all channels, writes group.json

group.list();               // ["general", "topic-research", "inbox-a1"]
group.channel("general");   // returns the Channel instance

// Add/remove channels at runtime
await group.addChannel({ name: "topic-new" });
await group.removeChannel("topic-new");

await group.stop();                    // stop channels, remove sockets + group.json
await group.stop({ removeDir: true }); // also remove the directory
```

**`group.json`** written on start (and updated on add/remove):

```json
{
    "created": "2026-02-07T18:00:00.000Z",
    "pid": 12345,
    "channels": [
        { "name": "general" },
        { "name": "topic-research" },
        { "name": "inbox-a1" }
    ]
}
```

### `encode` / `FrameDecoder`

Low-level framing utilities, exposed for custom transport implementations:

```typescript
import { encode, FrameDecoder } from "agent-channels";

const frame = encode({ msg: "hello" });  // Buffer

const decoder = new FrameDecoder(16 * 1024 * 1024);  // max message size
const messages = decoder.push(chunk);  // returns Message[]
decoder.reset();  // clear internal buffer
```

### `isValidMessage`

```typescript
import { isValidMessage } from "agent-channels";

isValidMessage({ msg: "hello" });                    // true
isValidMessage({ msg: "hi", data: { x: 1 } });      // true
isValidMessage({ msg: "" });                         // false (empty msg)
isValidMessage({ msg: "hi", data: [1] });            // false (data must be object)
```

## Bridges

A **bridge** connects a local channel to an external system. Messages flow bidirectionally: local channel ↔ bridge ↔ external. The bridge handles any protocol translation.

```
[ChannelClient] ←→ [Bridge] ←→ [External system]
```

The library ships a TCP bridge as a reference implementation. Future bridges (Discord, Matrix, IRC) would be separate packages.

### Bridge Interface

```typescript
interface Bridge {
    start(): Promise<void>;
    stop(): Promise<void>;
    get status(): "running" | "stopped" | "error";
}
```

### TCP Bridge

Expose a local channel over TCP. Same wire format as Unix sockets (4-byte length prefix + JSON), just on a different transport.

#### Server Mode

Listen for remote TCP connections. Messages from the local channel fan out to all TCP clients. Messages from TCP clients are forwarded to the local channel and to other TCP clients.

```typescript
import { Channel, TcpBridgeServer } from "agent-channels";

const channel = new Channel({ path: "/tmp/ch/general.sock" });
await channel.start();

const bridge = new TcpBridgeServer({
    channelPath: channel.path,
    host: "0.0.0.0",  // default: "127.0.0.1"
    port: 9100,
});
await bridge.start();

bridge.on("tcp-connect", (clientId) => console.log("remote connected:", clientId));
bridge.on("tcp-disconnect", (clientId) => console.log("remote disconnected:", clientId));

// Later...
await bridge.stop();
```

#### Client Mode

Connect a local channel to a remote TcpBridgeServer. Messages flow both ways. Auto-reconnects with exponential backoff on disconnect.

```typescript
import { Channel, TcpBridgeClient } from "agent-channels";

const channel = new Channel({ path: "/tmp/ch/general.sock" });
await channel.start();

const bridge = new TcpBridgeClient({
    channelPath: channel.path,
    host: "192.168.1.10",
    port: 9100,
    reconnect: true,         // default: true
    reconnectDelay: 500,     // initial delay ms, default: 500
    maxReconnectDelay: 30000, // max delay ms, default: 30000
});
await bridge.start();

bridge.on("tcp-connect", () => console.log("connected to remote"));
bridge.on("tcp-disconnect", () => console.log("disconnected from remote"));
bridge.on("reconnecting", (attempt, delay) => console.log(`reconnect #${attempt} in ${delay}ms`));
```

#### Two Machines Bridged

```
Machine A:                          Machine B:
  general.sock                        general.sock
       ↕                                  ↕
  TcpBridgeServer ←——— TCP ———→ TcpBridgeClient
```

Messages on Machine A's channel appear on Machine B's channel and vice versa. This is inter-agent communication over a network — no special protocol, just a TCP pipe between two channels.

#### ⚠️ Security Warning

The TCP bridge has **no encryption and no authentication**. This is intentional.

- **Trusted networks** (localhost, VPN, Tailscale): plaintext TCP is fine.
- **Untrusted networks**: wrap in an SSH tunnel, or build a TLS bridge variant.
- **Do not expose TCP bridges to the public internet.** Agents have shell access. A TCP bridge is effectively an RCE channel.

## Design Principles

- **Protocol-agnostic.** No opinions about what messages mean. No routing logic. Batteries not included.
- **Filesystem is the router.** Channels are sockets in a directory. Addressing is "which socket do you connect to."
- **One message format.** `{msg, data}`. No typed messages, no schema enforcement on `data`. Do whatever you want.
- **Bridges for external systems.** TCP, Discord, Matrix — each is a bridge that translates between local channels and an external protocol. The library ships a TCP bridge; others are separate packages.

## What It Doesn't Do

- **Authentication.** Anyone on the machine can connect to any socket.
- **Encryption.** Messages are plaintext.
- **Routing.** Fan-out only. Which channel you write to is the routing.
- **Auto-reconnect on ChannelClient.** Consumers handle reconnection. (The TCP bridge client has built-in reconnection.)
- **Backpressure.** OS socket buffers handle it.
- **Make you coffee.** Get a coffee machine

## License

MIT
