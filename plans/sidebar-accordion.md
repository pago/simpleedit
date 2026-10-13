# Plan: Sidebar accordion

Status: planned · Branch: `feat/sidebar-accordion` (worktree `sidebar-accordion`)

> Sessions, Backlog and Screen PRs share the left column as an accordion. Backlog and
> Screen PRs move their list column into the sidebar, so the main area gets back the
> 340–380px it currently gives to a second navigation column. A collapsed Sessions header
> shows the most urgent session state. A later phase collapses the whole sidebar into an
> icon rail with hover overlays.

## Why

Today the sidebar (default 260px, `App.svelte:28`) always shows the session list. Backlog
and Screen PRs then add their own fixed list column inside `<main>`: 340px for
`BacklogView` and 380px for `ScreenPrsView` (`ScreenPrsView.svelte:239`). So 600–640px of
navigation sits in front of the detail, and in those views the session list is the part
you aren't using.

## Locked decisions

- **The accordion is `uiView`.** Expanded section ↔ `uiView.current()`: `'workspace'`
  expands Sessions, `'backlog'` expands Backlog, `'screenprs'` expands Screen PRs. Exactly
  one section is always open. No second store, so the sidebar and the main area cannot
  disagree.
- **Session actions switch back automatically.** Backlog Start (`BacklogView.svelte:97`),
  Discuss with Agent (`PrDetail.svelte:101`) and clicking a session row
  (`SessionList.svelte:382`) already call `uiView.show('workspace')`, so they expand
  Sessions for free. Gap to close: **user-initiated** session creation does not switch the
  view today. That covers ⌘T (`App.svelte`), and in `SessionList` the ✦ Agent button, the
  new-session menu and + Term. Once ✦ Agent / + Term sit on a collapsed header, they must
  switch. Sessions an agent or the phone creates (spawn_session, hand-off, phone) do **not**
  steal the view.
- **Resizable, with a width remembered per section.** One drag handle, as today (clamped
  180–500). Each section remembers its own width in `localStorage`. The defaults match
  today's columns (Sessions 260, Backlog 340, Screen PRs 380), so nothing looks cramped on
  day one. The title-bar block keeps following the current width.
- **Cards respond to the space they have.** Sidebar sections use container queries
  (Tailwind 4.3 built-in: `@container` on the section body, then `@xs:`/`@sm:` variants on
  card internals). No viewport media queries. Each card decides what to drop as it narrows.
- **An empty main area is fine.** With nothing selected, the main area shows the view's
  header (Screen PRs: Screen/Re-screen plus the org/cutoff filters; Backlog: title and
  + New) and a one-line hint. The full-width "list fills the page" mode
  (`class:flex-1={!selectedKey}`) goes away.
- **The indicator uses the colours and animations we already have.** No new palette:
  - red `bg-red-500`: crashed (`exited`) or `error`
  - amber `bg-amber-400`: `waiting` (blocked on you)
  - blue `bg-blue-400`: finished since you last looked (the existing unread dot,
    `PaneTabBar.svelte:152`)
  - green `bg-emerald-400 animate-pulse`: running
  - grey `bg-zinc-600`: nothing to look at

  The collapsed Sessions header shows **one** dot, the most urgent of these across all
  sessions, in exactly that order. A tooltip gives counts ("2 awaiting input · 1 finished").
  Backlog and Screen PRs keep their current badges (count, red attention count).

## Phase 1: the "finished, unseen" state and the aggregate dot

Ships alone and is useful before the accordion exists: it adds the per-row blue dot.

1. **Unseen tracking.** New renderer store `stores/sessionAttention.svelte.ts`, keyed by
   terminal id:
   - *Mark* when an agent terminal's status goes from active (`initializing`/`running`)
     to `idle`, unless that session is currently on screen.
   - *On screen* means active session id === terminal, `uiView` is `'workspace'`, and
     `document.hasFocus()`.
   - *Clear* when the session comes on screen: an effect over the same three inputs,
     including window refocus while it's shown.
   - *Drop* on `pty:exit` / session close, next to `clearAgentStatusForTerminal`.
   - In memory only. A restart starts with nothing unseen.

   The transition hook is the `agent:status` listener in `stores/agent-status.svelte.ts`.
   It already sees the previous status, so it can report the transition rather than every
   event.
2. **Row dot.** `dotClass` in `SessionList.svelte:546` returns `bg-blue-400` for an idle,
   unseen agent session. `statusTitle` gains "Finished — not viewed yet".
3. **Aggregate.** A pure function `sessionsAttention(sessions) → { level, counts }` in
   `renderer/lib/` (precedence above, unit-tested) and a `<StatusDot level>` component that
   both the row and the header render, so the classes live in one place. The icon rail in
   phase 3 reuses the same component.
4. **Tests:** vitest for the precedence function and the mark/clear transitions (fake the
   three "on screen" inputs).

**Verify live:** Claude derives `running`/`idle` from the OSC title. Confirm a single turn
doesn't flip ✳/spinner mid-turn and leave a blue dot while the agent is still working. If
it does, mark on the `Stop` hook instead of the title transition.

## Phase 2: the accordion

### Sidebar shell
- `Sidebar.svelte` becomes three `SidebarSection`s (new component: header row plus a body
  that is `flex-1 min-h-0 overflow-y-auto @container` when expanded). The headers keep their
  order: an expanded middle section pushes the Screen PRs header to the bottom.
- **Sessions header:** label, aggregate dot, and the ✦ Agent / + Term buttons, moved out of
  `SessionList`'s sticky header (`SessionList.svelte`, the `sticky top-0` block) so they
  work while collapsed. The new-session context menu moves with them.
- **Backlog header:** label and count badge, as in today's `Sidebar.svelte` button.
- **Screen PRs header:** label and red attention badge, as today.
- Clicking the header of the already-open section does nothing.
- `App.svelte`: `sidebarWidth` reads and writes the width for the current section
  (`localStorage` key per section, same try/clamp pattern as `SessionWorkspace`'s
  collapse flags). The drag handler writes to the open section.

### Splitting Backlog
Extract `BacklogList.svelte`: list, drag reorder, Start/✕/confirm-delete, orphan drafts,
"New item" row. `BacklogView` keeps the header and `BacklogItemDetail`.

**Risk:** state that both halves use lives in `BacklogView` today and has to move.
- `newId`, `unsaved` and `startErrors` move into `backlogStore`, or into a small
  `backlogViewState` module if they shouldn't sit beside persisted data.
- The list calls `detail?.discard()` on remove (`BacklogView.svelte:107`). Replace that
  component ref with a store-level discard the detail subscribes to.
- The first-item auto-select effect (`:50-54`) moves with the list.
- The models list (`loadAllowlistedModels`) is used by both halves (`targetLabel` in rows,
  the picker in the detail). Hoist it to a shared store, or load it in both places.

### Splitting Screen PRs
Extract `ScreenPrsQueue.svelte`: pending cards, buckets, stacks, the `prCard` snippet,
quick-approve plus its `ConfirmReviewModal`. Selection is already in `screenPrsStore`, so
this split is mechanical. `ScreenPrsView` keeps the header and filters and `PrDetail`. The
empty states ("Screen your review queue to begin", "Finding PRs…", error) move to the queue.
The main area gets a one-line hint.

### Container queries
At a ~180px floor, drop in this order:
- **Screen PRs card:** finding counts → CI pill → verdict pills → +/− stats. Title,
  repo#number and the stack order pill always stay. Quick-approve stays hover-only.
- **Backlog row:** the subtitle line goes first. Start becomes an icon-sized ▶ below
  `@xs`. The ✕ always stays.
- **Session row:** already a single truncating line, so no change is needed. Check the
  ✉ mail badge at 180px.

### Shortcuts
⌘1 Sessions, ⌘2 Backlog, ⌘3 Screen PRs, in `App.svelte`'s `handleGlobalKeydown`. Nothing
in renderer or main binds digits today; confirm Monaco and xterm don't swallow them. Add
the entries to the command palette too.

### Tests and docs
- Browser tests for `Sidebar` (expanded section follows `uiView`, header badges, Sessions
  dot) and the split list components. `BacklogView.test.ts` moves with the list.
- `e2e/backlog.test.ts` drives the sidebar Backlog button; update the selectors and let CI
  run it (no local E2E).
- CLAUDE.md "Layout": update the diagram and text (sections, `uiView` ↔ accordion, width
  per section, the unseen state).

## Phase 3: icon rail (follow-up PR)

- **Collapse toggle** in the sidebar (a header chevron plus a shortcut; ⌘B if nothing
  claims it). The state persists in `localStorage`.
- **Rail:** about 40px, one icon per section (existing Sessions/backlog/magnifier glyphs).
  Each icon carries that section's indicator: `StatusDot` for Sessions, the count badges
  for the others. The icon of the current `uiView` shows the blue inset bar used today.
- **Overlay:** the section's normal body (the same components as phase 2), absolutely
  positioned over `<main>` so layout doesn't shift, at the section's remembered width.
  - Opens on hover-intent (~150ms), and stays open while the pointer is over the rail or
    the overlay. Closes ~300ms after leaving.
  - A click pins it open. Esc or an outside click closes it. ⌘1–3 open it while collapsed.
  - Choosing an item (session, backlog item, PR) navigates and closes the overlay.
  - Backlog drag reorder must work inside it, so dragging doesn't count as leaving.
- **Title bar:** the 78px traffic-light inset is wider than the rail. While collapsed, the
  title block keeps a minimum of 78px plus the repo name instead of following the rail's
  width.
- **Tests:** a browser test for open/pin/close and hover-intent timing, using fake timers.

## Out of scope
- `WorkspaceManager` unmounting while Backlog or Screen PRs is shown (`App.svelte:226-232`).
  That behaviour is unchanged.
- Phone layout (it already has its own nav stack).
