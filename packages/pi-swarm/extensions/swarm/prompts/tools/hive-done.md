## hive_done

Signal that your current task is complete. This transitions you to **idle state** — you stay alive, remain connected to channels, and keep your full context.

Before calling `hive_done`:
1. Write your report to your report file.
2. Update the notes file with any final findings or artifacts.
3. Include a one-line summary of what you accomplished.

After calling `hive_done`:
- You transition to **idle** — the process stays alive, channels remain connected
- Read any messages that arrived while you were working
- Check the plan file (if it exists) to see what work remains
- Wait for the queen to either:
  - **Re-task you** with new work via `swarm_instruct` (you'll resume with full context)
  - **Dismiss you** when you're no longer needed (you'll receive an instruction to exit)

Do NOT call any more tools or exit after `hive_done` until you receive new instructions.
