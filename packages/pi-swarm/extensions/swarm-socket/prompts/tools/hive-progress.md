## hive_progress

Report your current progress to the swarm dashboard. Fire-and-forget — no response expected.

- Use `phase` for what you're doing ("reading files", "running tests", "writing report").
- Use `percent` for completion estimate (0–100).
- Use `detail` for a short status line.
- Call periodically, especially before long operations, so the dashboard stays current.
