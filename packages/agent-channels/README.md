# agent-channels

A tiny Unix-socket messaging library built around two concepts:

- **Channel** — a named shared pub/sub channel with automatic server/client election and failover
- **Mesh** — a group of channels in one directory, with a convenience API for communal channels and DMs

That is the whole model.

## Install

```bash
npm install agent-channels
```

## Channel

A `Channel` is one socket-backed pub/sub group. The first joiner becomes the server. Later joiners connect as clients. If the server disappears, clients race to promote.

```ts
import { Channel } from "agent-channels";

const alpha = new Channel({
    path: "/tmp/demo/general.sock",
    name: "Alpha",
});

await alpha.join();
alpha.on("message", (msg, from) => {
    console.log(from, msg.msg);
});

alpha.send({ msg: "hello" });
await alpha.leave();
```

### Events

- `message` — `(msg, from)`
- `join` — `(name)`
- `leave` — `(name)`
- `role` — `("server" | "client")`
- `error` — `(err)`

### Properties

- `members`
- `role`
- `joined`
- `name`
- `path`

## Mesh

A `Mesh` groups channels inside one directory. It automatically joins:
- `general`
- your private DM inbox channel (`dm-<name>`)

Topic channels are just more channels. DMs are also channels.

```ts
import { Mesh } from "agent-channels";

const mesh = new Mesh({
    name: "Alpha",
    dir: "/tmp/demo-mesh",
});

await mesh.join();
await mesh.join("testing");

mesh.on("message", (msg, meta) => {
    console.log(meta.channel, meta.from, msg.msg);
});

mesh.send("hello everyone");
await mesh.sendTo("Beta", "private hello");
```

### DM model

Each agent owns a DM inbox channel named `dm-<name>`.

Sending a DM means:
1. join the target's DM channel
2. send the message
3. leave again

No separate inbox server type. No separate client API. Just channels.

### Mesh API

- `join(channel?)`
- `joinChannel(channel)`
- `leave(channel?)`
- `leaveChannel(channel)`
- `send(message, { channel? })`
- `sendAs(sender, message, { channel? })`
- `sendTo(target, message)`
- `sendToAs(sender, target, message)`
- `channels`
- `allMembers()`
- `channelMembers(name)`
- `name`
- `joined`
- `socketDir`

## Message format

```ts
interface Message {
    msg: string;
    data?: Record<string, unknown>;
}
```

`data` is pass-through metadata. The library uses it for sender identity and DM metadata, but consumers can add their own fields.

## Public exports

```ts
export { Channel };
export { Mesh };
export { type Message, isValidMessage };
export { encode, FrameDecoder };
```

## Development

```bash
npm test
npm run build
```
