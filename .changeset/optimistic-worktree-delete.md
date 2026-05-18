---
"simpleedit": patch
---

Make worktree deletion feel instantaneous. Clicking Confirm in the
Remove dialog now drops the row from the sidebar immediately while
`git worktree remove` runs in the background — you can queue up the
next delete without waiting on the previous one to finish. If the
backend call fails, the row pops back in at its original position and
the error surfaces above the list, so nothing is lost.
