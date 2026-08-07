---
"simpleedit": minor
---

Added first-class Codex support alongside Claude Code.

- Launch, resume, fork, hand off, and delegate between native Claude and Codex terminal sessions. Every agent launches at the project root, as Claude already did — agents create their own worktrees.
- Agent-to-agent messaging now spans both providers: a Codex session is addressable by `list_sessions` / `send_message` and receives mail through its `Stop` hook, the same channel Claude uses.
- Provider differences are declared as capabilities rather than hard-coded per provider, so the UI adapts (Shift+Enter handling, dropped-path format, labels, OSC-title policy, reporting setup) without naming a provider. Adding another agent means registering a descriptor.
- Codex lifecycle reporting (status, session identity, cwd/repo tracking) rides hooks whose command carries no per-session data, so Codex's hook-trust grant is a genuine one-time action instead of being invalidated on every launch.
- Added read-only Codex execution for Review, Tour, Screen PRs, every deep-review lens, and synthesis, with analysis-aware cache invalidation.
- Added Codex model discovery over the app-server catalog, with a configured-default fallback when it is unavailable.

Codex requires two one-time grants before its reporting works: trusting the hook command (via Codex's `/hooks`) and trusting the project directory. Until then a session says so in-place and falls back to coarse signals.
