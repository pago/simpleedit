---
"simpleedit": minor
---

Save and restore per-repo session on quit/launch. SimpleEdit now remembers
which worktrees were open in which panes, what tabs were active in each, and
which Claude Code sessions were running. On relaunch, the layout and tabs
come back automatically; Claude sessions appear as click-to-resume placeholder
tabs so launching the app doesn't fan out N concurrent `claude --resume`
processes across worktrees.
