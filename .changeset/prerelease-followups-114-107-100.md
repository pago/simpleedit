---
"simpleedit": patch
---

Three pre-release fixes in the terminal/status area:

- The worktree Claude status indicator no longer sticks on "running" after a Claude tab is closed mid-run (#114). Status is now tracked per-terminal and pruned on PTY exit, so a worktree drops back to idle when its last active Claude terminal goes away — and two Claude tabs in the same worktree no longer clobber each other's status.
- A renamed Claude tab's custom label now reliably survives a quit/relaunch (#100). The session-restore drain now reacts to late-staged resumes, fixing a mount-vs-hydrate race that could drop the restored tab.
- Removed the dead `--output-format stream-json` flag from the forked-Claude spawn (#107); it's ignored under a TTY on recent CLI versions.
