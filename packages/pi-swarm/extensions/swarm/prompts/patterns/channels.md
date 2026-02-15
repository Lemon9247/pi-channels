## Channels

Swarm communication uses **channels** — each channel is a Unix socket that fans messages out to all connected readers.

There are two kinds of channels:

- **General**: A broadcast channel. All agents and the queen are connected. Use it for announcements and anything the whole swarm should see.
- **Inboxes**: Each agent and the queen has a private inbox. Anyone can write to it, but only the owner reads it. Use inboxes for targeted messages and instructions.

**Channels carry real content.** When you call `message`, the `content` field is what recipients read. Don't just say "I updated something" — say what you found. The channel is the primary communication surface.
