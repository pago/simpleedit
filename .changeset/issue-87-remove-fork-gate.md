---
"simpleedit": minor
---

Remove the `SIMPLEEDIT_EXPERIMENTAL_FORK=1` env var gate around the Fork-into-worktree menu item. The feature now ships unconditionally — the existing per-tab disable logic (Agent View tabs disabled, Claude tabs with no captured session_id disabled with "waiting…" tooltip) is the source of truth for whether Fork can actually run for a given tab.

Drops the `app:experimental-fork` IPC channel and the renderer's mount-time fetch of it. Net diff is a small simplification of `TerminalTabs.svelte`, removal of the IPC type and handler, and pruning of the gate-specific e2e tests (the disable-behavior tests are retained).
