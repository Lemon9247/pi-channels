# agent-channels

Channel-based messaging over Unix domain sockets. Simple, protocol-agnostic, zero runtime dependencies.

## What is this for

A library for inter-agent communication on a single machine. Agents connect to Unix domain sockets to send and receive messages. Modeled after IRC/Discord — agents join named channels and receive all messages broadcast to that channel.

Simple and dumb, but reliable.

## Install

```bash
git clone git@github.com:sigilmakes/pi-channels.git
cd pi-channels/packages/agent-channels
npm install
```

Requires Node.js 20+.

## Quick Start

```typescript
import { Channel } from "agent-channels";

// Server: create a channel socket
const channel = new Channel({ path: "/tmp/my-channel.sock" });
await channel.start();

channel.on("message", (msg, clientId) => {
    console.log(`${clientId}: ${msg.msg}`);
});

// Broadcast to all clients
channel.broadcast({ msg: "hello everyone" });

// Stop when done
await channel.stop();
```

```typescript
import { ChannelClient } from "agent-channels";

// Client: connect to a channel
const client = new ChannelClient("/tmp/my-channel.sock");
await client.connect();

client.on("message", (msg) => {
    console.log(msg.msg);
});

client.send({ msg: "hello from client" });
```

## Concepts

### SharedChannel

Most agents use `SharedChannel` instead of raw `Channel`. It handles the server/client election automatically:

```typescript
import { SharedChannel } from "agent-channels";

const sc = new SharedChannel("/tmp/general.sock", { name: "MyAgent" });
await sc.join();  // becomes server if no one else is, otherwise client

sc.on("message", (msg) => {
    console.log(`${msg.data?.name}: ${msg.msg}`);
});

sc.send({ msg: "hello" });
```

When one agent joins first, it becomes the "server" (owns the socket). When another agent joins, it becomes a "client" that connects to the server. If the server leaves, one of the clients automatically promotes to server.

### Mesh

For managing multiple channels (like Discord/IRC), use `Mesh`:

```typescript
import { Mesh } from "agent-channels";

const mesh = new Mesh({
    name: "MyAgent",
    dir: "/tmp/pi-channels/my-project",
});
await mesh.join();

// Join topic channels
await mesh.joinChannel("general");
await mesh.joinChannel("testing");

// Send to a channel
mesh.send("hello everyone", { channel: "general" });

// Direct message
await mesh.sendTo("OtherAgent", "hello there");

mesh.on("message", (msg, meta) => {
    console.log(`[${meta.channel}] ${meta.from}: ${msg.msg}`);
});
```

### Messages

One format for everything:

```typescript
interface Message {
    msg: string;                     // Human-readable content
    data?: Record<string, unknown>;  // Optional structured payload
}
```

`msg` must be a non-empty string. `data`, if present, must be a plain object. The library validates shape but does not interpret content.

### Wire Format

Messages are length-prefixed JSON over the socket:

```
[4 bytes: uint32 BE payload length][N bytes: UTF-8 JSON]
```

Maximum message size: 16 MB. The `FrameDecoder` handles partial reads and multi-message chunks.

## API

### `Channel`

```typescript
const channel = new Channel({
    path: "/tmp/my-channel.sock",
    echoToSender: false,  // default: don't echo back to sender
});

await channel.start();

channel.on("message", (msg, clientId) => { /* client sent a message */ });
channel.on("connect", (clientId) => { /* client connected */ });
channel.on("disconnect", (clientId) => { /* client disconnected */ });
channel.on("error", (err) => { /* server or client error */ });

channel.broadcast({ msg: "announcement" });
console.log(channel.clientCount);  // number of connected clients
console.log(channel.started);      // whether listening
console.log(channel.path);         // socket path

await channel.stop();  // disconnect all, unlink socket
```

**Stale socket detection:** On `start()`, if the socket file already exists, the channel tries to connect. If nothing is listening (ECONNREFUSED), it's stale — removed and replaced. If something is listening, throws `"Socket already in use"`.

### `ChannelClient`

```typescript
const client = new ChannelClient("/tmp/my-channel.sock");
await client.connect();

client.on("message", (msg) => { /* received */ });
client.on("connect", () => { /* connected */ });
client.on("disconnect", () => { /* connection lost */ });
client.on("error", (err) => { /* error */ });

client.send({ msg: "hello" });
console.log(client.connected);  // true

client.disconnect();
```

No auto-reconnect by default. If the connection drops, `"disconnect"` fires and the consumer can reconnect manually.

### `SharedChannel`

```typescript
const sc = new SharedChannel("/tmp/general.sock", {
    name: "MyAgent",
    echoToSender: false,
});

await sc.join();  // server or client, handles election automatically

sc.send({ msg: "hello" });

sc.on("message", (msg, from) => {
    console.log(`${from}: ${msg.msg}`);
});

sc.on("join", (name) => console.log(`${name} joined`));
sc.on("leave", (name) => console.log(`${name} left`));

console.log(sc.role);      // "server" | "client" | null
console.log(sc.members);  // connected member names

await sc.leave();  // disconnect, cleanup
```

**Server election:** If no server exists, this instance becomes server. If a server exists, this instance becomes client and connects. If server dies, clients race to promote one to server.

### `Mesh`

```typescript
const mesh = new Mesh({
    name: "MyAgent",
    dir: "/tmp/pi-channels/project/",
});

await mesh.join();  // joins "general" channel automatically

// Topic channels
await mesh.joinChannel("testing");
await mesh.leaveChannel("testing");

// Send
mesh.send("hello", { channel: "general" });
await mesh.sendTo("OtherAgent", "private message");

// Inspect
console.log(mesh.channels);          // ["general", "testing"]
console.log(mesh.allMembers());      // all agents in any channel
console.log(mesh.channelMembers("general"));  // agents in #general

// Direct message
await mesh.sendTo("TargetAgent", "hello");

mesh.on("message", (msg, meta) => {
    console.log(`[${meta.channel}] ${meta.from}: ${msg.msg}`);
});

mesh.on("join", (name, channel) => { /* agent joined */ });
mesh.on("leave", (name, channel) => { /* agent left */ });
```

### `encode` / `FrameDecoder`

Low-level framing utilities:

```typescript
import { encode, FrameDecoder } from "agent-channels";

const frame = encode({ msg: "hello" });  // Buffer

const decoder = new FrameDecoder(16 * 1024 * 1024);  // max message size
const messages = decoder.push(chunk);  // returns Message[]
decoder.reset();  // clear internal buffer
```

### `isValidMessage`

```typescript
isValidMessage({ msg: "hello" });           // true
isValidMessage({ msg: "hi", data: { x: 1 } }); // true
isValidMessage({ msg: "" });                  // false
isValidMessage({ msg: "hi", data: [1] });    // false
```

## Design Principles

- **Protocol-agnostic.** No opinions about what messages mean. No routing logic.
- **Filesystem is the router.** Channels are sockets in a directory. Addressing is "which socket."
- **One message format.** `{msg, data}`. No typed messages, no schema enforcement on `data`.
- **Simple by design.** Complexity lives in the consumer, not the library.

## What It Doesn't Do

- **Authentication.** Anyone on the machine can connect to any socket.
- **Encryption.** Messages are plaintext (OS-level permissions only).
- **Routing.** Fan-out only. The socket path is the address.
- **Auto-reconnect on ChannelClient.** Consumers handle reconnection manually.
- **Backpressure.** OS socket buffers handle it.

## License

MIT
