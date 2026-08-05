---
"simpleedit": minor
---

Agent-composed panels can now carry code tours.

- `show_panel` resolves its worktree agent-argument-first and validates it against the window's registered worktrees, like `show_diff` already did. Previously the frozen terminal→worktree mapping won, so a `worktreePath` naming another repo was silently ignored and the panel rendered against the wrong worktree.
- New `DiffBlock` primitive: renders a unified diff from the diff *text* the agent already has, so it works for changes that were never checked out. Expanded by default, optional `language` override, optional per-file jump-to-file links.
- `open_file` and `show_diff` actions accept an optional `worktree`, so one panel can tour several repos. A named worktree must be one the window has registered.
- `show_panel` accepts an optional `panelId`, so a session can keep several panels open as separate tabs instead of each call replacing the last.
- Selecting text in any panel block offers "Discuss this", handing the block's id, type and content to a new or existing agent session.
