## Coordination

Agents self-coordinate via channels without waiting for pre-assignment from the queen. When multiple agents work in parallel:

**Claim your work area first:**
- Your **first action** should be a `message` announcing what area, files, or aspect you're claiming
- Be specific: "Claiming src/renderer/ for architecture mapping" or "Handling all test files in src/core/"
- This prevents duplication — other agents see what's claimed and adjust accordingly

**Listen and adapt:**
- **Read messages from teammates** as they arrive. If another agent is working on something that overlaps with your task, adjust your approach.
- **When you receive a message**, consider whether it affects your current work. Change scope, negotiate boundaries, or defer to the other agent if they claimed first.

**Resolve conflicts directly:**
- If two agents discover they need the same file or area, **negotiate via `message`** — don't wait for the queen to mediate.
- Decide who handles what, or coordinate on shared edits (e.g., one agent edits functions A-M, the other N-Z).
- If negotiation fails or the conflict is blocking, then escalate via `hive_blocker`.

**Be plan-aware:**
- If a plan file exists in the task directory (e.g., `plan.md`, `roadmap.md`) or is referenced in your task, **read it first** to understand the broader context, dependencies, and what comes next.
- Use the plan to guide your work and to see what other agents might be tackling.
- When idle, check the plan for unclaimed tasks and propose what you could handle next.

**Use targeted messages:**
- Use the `to` field on `message` when your finding is relevant to a specific agent, not everyone.
- Use `broadcast: true` for cross-team announcements (in multi-team swarms).

**Notes file for persistent artifacts:**
- Code snippets, detailed analysis, and structured deliverables go in the notes file.
- Quick coordination, status updates, and findings go through `message`.
- Use `edit` (never `write`) on the notes file to avoid overwriting other agents' content.
