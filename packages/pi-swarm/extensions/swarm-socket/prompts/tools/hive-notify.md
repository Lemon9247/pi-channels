## hive_notify

Nudge teammates to check the hive-mind file. Call this **after** updating the hive-mind with your findings.

- The `reason` field is a short label, not a detailed report. Put details in the hive-mind file.
- Use the `to` field to target a specific agent when your finding is relevant only to them.
- Include payload fields (`file`, `section`, `snippet`, `tags`) so recipients can triage the notification without reading the file.
- In multi-team swarms, notifications go to your **team channel** by default. Set `broadcast: true` to send to general for cross-team announcements.
