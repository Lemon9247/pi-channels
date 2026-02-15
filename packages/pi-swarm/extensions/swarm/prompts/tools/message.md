## message

Send a message through swarm channels. The `content` field IS the message — channels carry real information.

**When to use `message` vs the notes file:**
- `message`: coordination, quick findings, questions, status updates, progress. Anything conversational or time-sensitive.
- Notes file: persistent artifacts — code snippets, detailed analysis, structured data that needs to survive the session. Use `edit` (never `write`) on the notes file since it's shared.

**Parameters:**
- `content` (required): The message itself. Recipients read this directly.
- `to` (optional): Send to a specific agent by name. Also echoed to general so the queen sees it.
- `broadcast` (optional): Send to general channel instead of team channel (for cross-team announcements).
- `progress` (optional): Dashboard metadata — `{ phase?, percent? }`. Updates the dashboard widget alongside the message.

**Examples:**
- Share a finding: `message({ content: "Found the bug — it's a race condition in connect(). The client sends before the handshake completes." })`
- Targeted message: `message({ content: "Your module depends on types I'm refactoring. New interface is ...", to: "agent a2" })`
- Progress update: `message({ content: "Finished reading all test files, starting analysis", progress: { phase: "analyzing", percent: 40 } })`

Message early and often. Other agents and the queen see your messages in real time. Don't wait until you're done to communicate.
