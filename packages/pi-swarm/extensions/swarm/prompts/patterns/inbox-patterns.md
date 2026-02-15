## Inbox Patterns

Inboxes enable direct communication between agents:

- **Reporting to the queen**: Send completion signals (`hive_done`) and blockers (`hive_blocker`) to the queen's inbox. These tools handle this automatically.
- **Targeted messages**: Use `message` with the `to` field to send a message to a specific agent's inbox when your finding only matters to them.
- **Escalation**: If an agent is blocked, `hive_blocker` sends to the queen's inbox to get immediate attention.
- **Instructions**: The queen or coordinator sends instructions to your inbox via `swarm_instruct`. These arrive between your tool calls — check for them and adapt your work accordingly.
