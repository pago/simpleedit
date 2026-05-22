---
"simpleedit": patch
---

Fix long-running terminal sessions (tmux, Claude agent teams) disappearing on
worktree switch. Terminal ids were minted as `term-${Date.now()}-${nextIndex}`,
which collided whenever PaneManager mounted several WorktreePanes in the same
tick — common during session restore. Multiple Terminal components then attached
to the same PTY id, wedging their xterm renderers. Switched to `crypto.randomUUID()`.
Fixes #88.
