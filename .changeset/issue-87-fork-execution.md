---
"simpleedit": minor
---

Fixes #87: enable Fork-into-worktree execution behind `SIMPLEEDIT_EXPERIMENTAL_FORK=1`.

Right-clicking a Claude tab now offers a real "Fork into worktree…" entry (gated by the experimental env var introduced in PR3). Picking it opens an inline worktree picker; choosing a target worktree forks the source Claude session into it: SimpleEdit pre-mints the fork's session-id, copies the source transcript (and any subagent subdir) into the target's `~/.claude/projects/...`, then spawns `claude --session-id <new> --resume <src> --fork-session` in the target cwd. The new tab appears as an italic-dimmed placeholder until Claude emits its first byte, at which point it transitions to a live Terminal. Fork failures auto-clear after ~6s.

Agent View tabs cannot be forked (the TUI emits no session id); the menu item is disabled with a dedicated tooltip. The auto-memory dir (`~/.claude/projects/<cwd>/memory/`) is intentionally NOT copied — it's project-scoped, not session-scoped, and copying would pollute the target worktree's existing memory.

Stacked on #101.
