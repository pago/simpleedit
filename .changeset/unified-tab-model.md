---
"simpleedit": minor
---

Replace the per-pane mix of editor / DiffReview / PlanView / TourPanel content modes with a unified per-worktree tab model. Files, diffs, tours, and plans are now sibling tabs in a single tab bar — multiple diffs can be open at once, plans and tours sit alongside the diff that spawned them, and clicking a commit in the GitLog opens its diff as a peek tab (replaced by the next peek action unless pinned via double-click). Each tab kind has a distinct leading icon for at-a-glance scanning. Agent-initiated content (plans, tours via existing MCP tools) auto-focuses when the pane is idle and otherwise opens in the background with an unread marker that clears on focus. The GitLog gains a trailing tour icon that opens (or focuses) a tour tab for the commit, and stays persistently highlighted on commits that already have a tour. The command palette gains "Tour commit: …" entries for the most-recent commits in the active worktree.
