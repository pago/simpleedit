---
"simpleedit": patch
---

Fixes #89: resolve the "main" worktree by reading the bare repo's default branch instead of trusting the porcelain list order. With a bare repo, `git worktree list --porcelain` could return a non-default branch first (alphabetically), causing SimpleEdit to suppress the delete button on the wrong worktree.
