# Worktree UX Improvement Plan

E2E tests for all four flows live in `e2e/repro-worktree-*.test.ts` (scratch files,
not yet promoted to `e2e/ide.test.ts`). This plan captures what each agent observed
and prioritises the improvements.

---

## Cross-cutting issues (affect all flows)

### 1. Silent error handling everywhere
Every async operation (`handleCreate`, `handleCheckout`, `handleRemove`) has no
`try/catch`. If the IPC call throws, the UI silently dismisses itself. Users see no
feedback; the operation may have failed.

**Fix:** Add a shared `let errorMsg = $state('')` displayed as a small red message
below the active action area, wrapping every IPC call in `try/catch`.

### 2. No in-progress feedback on any async operation
Creating, checking out, and deleting a worktree all involve IPC calls that can take
seconds. None of them show a spinner or disabled state while in flight.

**Fix:** Add a `let busy = $state(false)` flag; set it around every IPC call to
disable the confirm button and show a spinner.

### 3. `isMain` heuristic is fragile
`isMain: branch === 'main' || branch === 'master'` is hard-coded in three places.
Repos using `trunk`, `develop`, or any other default branch name will never protect
their primary worktree from deletion, and may not show correct status badges.

**Fix:** Mark `isMain` based on position in `git worktree list` output (the first
entry is always the main worktree), not branch name.

---

## Switch worktree

### What works well
- `aria-selected` / `role="option"` / `role="listbox"` markup is correct and accessible.
- Both `Enter` and `Space` keyboard activation are wired up.
- The pane keep-alive pattern (`visitedPrimaryPaths`) means switching never destroys open editor tabs or terminal sessions.
- Green/grey dot gives instant visual feedback on which worktree is active.
- Per-worktree Claude status badge (idle/running/waiting/error) is useful ambient signal.

### Pain points & improvements

| # | Issue | Improvement |
|---|-------|-------------|
| S1 | Switching to an unvisited pane shows no loading state | Add a `data-loading` attribute or skeleton on the pane header on first mount |
| S2 | `isCurrent` field is always `false` — never set correctly | Either populate from `parsePorcelain` or remove the field |
| S3 | Sidebar always targets the primary pane, even in split view | Target the focused pane; or show a tooltip "Changes left pane" |
| S4 | No visual distinction for the main/protected worktree | Add a small lock icon or `main` label next to the main worktree entry |
| S5 | Cancel button in delete confirmation doesn't stop propagation | Add `e.stopPropagation()` to the Cancel button handler (see Delete section) |
| S6 | Empty state "No worktrees found" has no call to action | Add a hint: "Use '+ New' to create your first worktree" |

---

## Add new worktree

### What works well
- `sanitizeBranchName` silently strips illegal characters on every keystroke — low friction.
- Create button is disabled until the name is valid — good affordance cue.
- `Enter`/`Escape` shortcuts work as expected.
- Input is auto-focused via `tick()`.
- `onfocusout` on the wrapper cancels the form when focus leaves — prevents orphaned forms.

### Pain points & improvements

| # | Issue | Improvement |
|---|-------|-------------|
| A1 | No loading state while `worktree:create` is in flight | `busy` flag + "Creating…" label on the button |
| A2 | Errors silently swallowed — no `try/catch` | Wrap in `try/catch`, show `errorMsg` below input |
| A3 | No duplicate name check in the UI | Pre-validate against `worktreeList()` branches with an inline hint |
| A4 | After creation, user must manually click to activate | Auto-select (`setActiveWorktree`) the newly created worktree |
| A5 | `onfocusout` cancel can fire before `onclick` on Create when `relatedTarget` is null (Electron/Chromium) | Debounce `onfocusout` by one microtask or check against a `submitting` flag |
| A6 | Characters stripped by sanitizer with no signal to user | Show a transient hint "Some characters were removed" when sanitization changes the value |

---

## Checkout remote branch

### What works well
- Two distinct buttons ("Checkout" vs "+ New") clearly separate the two intents.
- Incremental filtering with `branchFilter` requires no extra IPC round-trip.
- Double-click on a branch row bypasses the Checkout button — nice shortcut.
- Filter input has `autofocus`, so keyboard is immediately usable.
- `listAvailableBranches` deduplicates and strips `remotes/origin/` prefixes cleanly.

### Pain points & improvements

| # | Issue | Improvement |
|---|-------|-------------|
| C1 | No loading state while fetching branch list | Spinner/`aria-busy` on the list container during the `worktree:branches` fetch |
| C2 | No error state if fetch or checkout throws | `try/catch` + `errorMsg` inline display |
| C3 | `onfocusout` cancel is too aggressive — accidental click outside silently discards selection | Replace with explicit "press Escape to cancel" or a click-outside overlay |
| C4 | Local and remote branches look identical after prefix stripping | Prefix remote-only entries with a small icon or `origin/` label |
| C5 | No "Fetch first" option — stale remote refs may be missing from list | Add a refresh icon that triggers a `worktree:fetch` IPC before re-listing |
| C6 | Worktree path collision on checkout not surfaced | Catch the git error and show: "A directory `<name>` already exists. Run `git worktree prune` first." |

---

## Delete worktree

### What works well
- Two-step confirmation (hover to reveal Remove, then Confirm) prevents fat-finger accidents.
- Remove button is hidden by default (`opacity-0`), keeping the list uncluttered.
- `e.stopPropagation()` on Remove and Confirm prevents accidental row activation.
- Main worktrees have no Remove button at all — the affordance simply doesn't exist.
- `--force` on `git worktree remove` avoids hanging on uncommitted changes.

### Pain points & improvements

| # | Issue | Improvement |
|---|-------|-------------|
| D1 | No irreversibility warning — "Confirm" gives no hint that uncommitted changes will be lost | Add `title="Uncommitted changes in this worktree will be lost"` to the Confirm button; consider a bolder warning for worktrees with unstaged changes |
| D2 | Deleting the active worktree leaves the pane pointing at a deleted path | After deletion, if `activeWorktree().path === deletedPath`, fall back to the first remaining worktree |
| D3 | No loading state during `worktree:remove` IPC call | Brief disabled/spinner state on the list item while in flight |
| D4 | Cancel button missing `e.stopPropagation()` — click propagates to row, re-selecting the worktree | Add `e.stopPropagation()` to the Cancel button's `onclick` |
| D5 | `isMain` heuristic (see cross-cutting #3) | Fix at the data layer — see above |
| D6 | Confirmation UI (`text-[10px]`) is very small; easy to mis-click on dense lists | Slightly larger text/buttons, or a brief tooltip on hover over the small zone |

---

## Priority order

These are the highest-impact changes to tackle first, roughly ordered:

1. **Error handling everywhere** (A2, C2, D1 — cross-cutting) — silent failures are the most confusing UX possible
2. **Delete active worktree → pane fallback** (D2) — likely causes a broken UI state today
3. **`isMain` heuristic** (cross-cutting #3) — currently fails silently for non-standard default branches
4. **Auto-select after create** (A4) — biggest workflow friction: create → must manually click
5. **Loading states** (A1, C1, D3) — makes the app feel responsive
6. **Cancel `stopPropagation`** (D4, S5) — two-line fix, eliminates a subtle bug
7. **Remote vs local branch distinction** (C5) — prevents confusing checkout failures
8. **`onfocusout` robustness** (A5, C3) — edge case but can lose work
9. **Sidebar targets focused pane in split view** (S3) — important for the multi-pane workflow
