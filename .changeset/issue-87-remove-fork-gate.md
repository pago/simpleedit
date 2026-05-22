---
"simpleedit": patch
---

Remove experimental gate for fork-into-worktree. The fork execution path (PR #104) has comprehensive safety nets — env var gating was no longer providing meaningful safety value over the runtime checks.
