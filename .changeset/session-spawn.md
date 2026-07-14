---
"simpleedit": minor
---

Add session spawn & hand-off — one primitive surfaced as three actions for escaping a bloated agent context:

- **`spawn_session` MCP tool** — an agent can start a fresh primary Claude session seeded with a brief, to hand off (`target: 'replace'`) or fan out (`target: 'new-pane'`) work. Fire-and-forget; inherits the caller's model/worktree unless overridden.
- **Hand off…** — a sidebar action that assembles an editable brief (the session's goal, a changed-file summary, touched repos, and PLAN/PR pointers — never file contents) and resets the session in place onto a clean context.
- **Fork** — the old "Fork into worktree" is now an in-place full-context fork: it branches the conversation into a fresh session paired with the origin, with no JSONL copy or worktree targeting. The worktree-fork machinery (placeholder state, worktree picker, JSONL copy) is removed.

The session's seed prompt is now persisted on the session record (and across restarts) so hand-off can recover the goal without re-reading the transcript.
