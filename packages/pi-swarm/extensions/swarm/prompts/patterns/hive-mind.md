## Hive-Mind

The hive-mind file is the swarm's shared memory — a markdown file that all agents read and write. Channels are ephemeral notifications; the hive-mind is the persistent record.

**When to use channels vs hive-mind:**
- Channels: "I updated the hive-mind" (nudge), "I'm done" (signal), "I'm blocked" (alert)
- Hive-mind: detailed findings, code snippets, analysis, questions, status updates

**CRITICAL — The hive-mind file is shared.** Multiple agents write to the same file. NEVER use the `write` tool on the hive-mind — it overwrites the entire file and destroys other agents' work. ALWAYS use the `edit` tool to surgically insert your content. Read the file first to see what's there, then use `edit` to add your findings below existing content.
