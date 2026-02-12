## Channels

Swarm communication uses **channels** — each channel is a Unix socket that fans messages out to all connected readers. One writer sends a message, every reader on that channel receives it.

There are two kinds of channels:

- **General**: A broadcast channel. All agents and the queen are connected. Use it for announcements, nudges, and anything the whole swarm should see.
- **Inboxes**: Each agent and the queen has a private inbox. Anyone can write to it, but only the owner reads it. Use inboxes for targeted messages — instructions, direct nudges, completion signals.

**Keep channel messages minimal.** The `reason`, `description`, and `summary` fields in your tools are short labels. Put detailed findings in the hive-mind file, not in the channel message.
