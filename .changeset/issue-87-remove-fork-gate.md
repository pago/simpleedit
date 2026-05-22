---
"simpleedit": patch
---

Fork-into-worktree menu item is now available without an experimental gate. The execution path (PR #104) has comprehensive safety nets — env var gating was originally introduced for caution but proved redundant given the per-tab disable logic.
