---
"simpleedit": minor
---

Stage 4 — multi-repo sessions. A session's workspace can now view worktrees from more than one bare repo: a repo picker (left of the worktree picker) points the viewer at another repo's worktrees without changing the session's launch dir or model. The `worktree:*` IPC handlers take an optional `repoPath` (the per-window repo map stays as the single-repo default), the cwd→worktree resolver matches across all of a window's opened repos, and per-session `repoPath` persists across restart. Recently-viewed deferred.
