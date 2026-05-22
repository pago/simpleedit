---
"simpleedit": minor
---

Fixes #87 (rename + menu skeleton; fork and close in follow-up PRs).

Adds a context menu to agent terminal tabs (Claude and Agent View). The menu surfaces "Rename…" today; "Fork into worktree…" and "Close session" appear as disabled placeholders that future PRs will wire up.

- The menu opens on right-click, click of the new `⋯` overflow button (visible on hover/focus), Shift+F10, or the ContextMenu key.
- Rename uses the existing `PromptModal` (moved to `src/renderer/components/` since it now spans features).
- User-renamed tabs are sticky — `handleTitleChange` early-returns so the PTY's OSC title can't overwrite the chosen label. The `customLabel` flag persists across session save/load, including for Agent View tabs.

Stacked on #92.
