---
"simpleedit": minor
---

Session location tracking (Stage 2). Spawned Claude sessions now report their working directory to SimpleEdit via injected HTTP hooks, and the session's workspace (file tree, git log, diff targets) automatically follows the agent into whichever worktree it's working in. Adds two MCP tools so agents can drive the UI directly: `open_worktree` (repoint the workspace) and `show_diff` (open a diff tab).
