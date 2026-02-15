## Notes File

The notes file is the swarm's shared persistent memory — a markdown file for artifacts that need to survive the session.

**When to use channels vs the notes file:**
- Channels (`message` tool): real-time coordination, findings, questions, status updates. This is the primary communication surface.
- Notes file: persistent artifacts — code snippets, detailed analysis, structured data, deliverables. Things that agents or humans will reference after the swarm ends.

**CRITICAL — The notes file is shared.** Multiple agents write to the same file. NEVER use the `write` tool on the notes file — it overwrites the entire file and destroys other agents' work. ALWAYS use the `edit` tool to surgically insert your content. Read the file first to see what's there, then use `edit` to add your findings below existing content.
