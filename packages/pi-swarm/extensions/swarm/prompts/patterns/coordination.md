## Coordination

When multiple agents work in parallel, follow these patterns to avoid duplication and conflicts:

- **Message early.** Post what you're working on via `message` so others know not to duplicate it.
- **When you receive a message**, consider whether it affects your current work. Adjust your approach if needed.
- **Use targeted messages** (the `to` field on `message`) when your finding is relevant to a specific agent, not everyone.
- **Use the notes file for persistent artifacts** — code snippets, analysis, structured deliverables. Quick coordination goes through `message`.
