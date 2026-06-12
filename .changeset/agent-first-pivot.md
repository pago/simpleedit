---
"simpleedit": minor
---

Agent-first UI pivot (Stage 1): sessions replace worktrees as the primary navigation entity. The sidebar lists agent/terminal sessions with live status; each session owns its workspace (tabs, worktree selection, file tree, git log) which is preserved across switches. A new session starts as a full-bleed terminal and grows viewer chrome when the first tab opens. Worktrees are demoted to a management section; clicking one repoints the active session's workspace. The Split concept is removed. Session persistence is rekeyed to sessions (save format v2) — agent sessions restore as click-to-resume entries with their tabs.
