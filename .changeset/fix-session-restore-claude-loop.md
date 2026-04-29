---
"simpleedit": patch
---

Fix three bugs in the v0.12.0 session save/restore feature that surfaced as
soon as a Claude tab was opened, freezing every subsequent click in the
renderer:

- **`effect_update_depth_exceeded` (Svelte 5 infinite-loop guard).**
  `publishClaudeTabs` and the other `sessionRestoreStore` writers cloned
  their own state via `new Map(_state)` and assigned the result back. Inside
  the `$effect` in `TerminalTabs` that publishes Claude tabs on every change,
  that's a tracked-read followed by a write to the same state — Svelte 5's
  canonical loop pattern. Reads are now wrapped in `untrack`.

- **`DataCloneError` in `flushSessionSave`.** `serializeSession` embedded the
  `_visitedPrimaryPaths` / `_visitedSecondaryPaths` Svelte 5 reactive proxy
  arrays directly in the saved payload. `structuredClone` (used by Electron
  IPC) refuses to clone the proxy. The serializer now spreads them into
  plain arrays.

- **`hydrateSession` stranding the user with an invisible pane.** The first
  save after the loop bug froze `visitedPrimary: []` to disk. On every
  subsequent launch, hydrate cleared the path that `PaneManager`'s
  add-on-`primaryPath`-change effect had just added — and because
  `primaryPath` didn't transition again, the effect never re-fired.
  `WorktreePane` was never mounted; the editor pane was empty and clicks in
  the Git Log appeared to do nothing. Hydrate now ensures the active
  worktree paths are present in `visitedPrimary` / `visitedSecondary` after
  filtering.
