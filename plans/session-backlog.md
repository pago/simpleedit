# Plan: Session backlog

Status: draft (design review) · Branch: `feat/session-backlog`

> Queue up session prompts per repo and start them later from desktop or phone, with
> Claude able to curate the list. A backlog item is a deferred
> [`spawn_session`](./session-spawn.md) call: prompt plus model, provider and worktree.

## Goal

Each repo gets a backlog of prepared session prompts. You can add, edit, reorder, remove
and **start** items from three places: the desktop app, the phone companion, and Claude
via MCP. Starting an item opens a new session with that prompt and its saved
settings. The item then leaves the backlog, and the session shows up in the sidebar
like any other.

**Non-goals for v1:** a dashboard of running sessions, Queued → Running → Done columns,
linking an item to the session it became, templates that survive a start, and
scheduled or automatic starts.

## Decisions already made

| Decision | Choice |
|---|---|
| Scope | One backlog per repo, shared by all of that repo's worktrees |
| Storage | JSON owned by main (not a markdown file), because each item needs its own model |
| On start | The item is removed and the session appears in the session list |
| Who can add | Claude (MCP), the user on desktop, the user on the phone |
| Who can start | The user on desktop and on the phone (Claude: see Q1) |
| Entry point | A sidebar button above "Screen PRs" |

## Data model (`src/shared/backlog.ts`)

```ts
interface BacklogItem {
  id: string                 // minted by the client; never reused
  prompt: string             // the new session's opening message
  label?: string             // sidebar name; defaults to one derived from the prompt
  provider?: 'claude' | 'codex' | 'opencode'   // omitted = the default provider
  model?: string             // omitted = that provider's default model
  reasoningEffort?: ReasoningEffort            // Codex only, same rule as spawn_session
  worktree?: string          // absolute path; omitted = picked at start time
  version: number            // goes up on every edit; used to detect conflicting edits
  createdAt: string
  createdBy: 'desktop' | 'phone' | 'agent'
  lastStartError?: string    // set when a start failed; cleared on the next edit or start
}

type BacklogOp =
  | { op: 'add'; item: NewBacklogItem; index?: number }
  | { op: 'update'; id: string; baseVersion?: number; patch: Partial<EditableFields> }
  | { op: 'remove'; id: string }
  | { op: 'reorder'; ids: string[] }
```

`applyBacklogOp` is a **pure function in `src/shared/`**. Main uses it to apply the
real change, and clients use it to update their own view straight away before main
confirms. This copies `applyDraftOp` in `src/shared/review-drafts.ts`. If an op changes
nothing, it returns the same object, so main can skip the write and the broadcast.

How each op behaves:
- **`reorder`:** ids you list come first, in your order. Ids you leave out keep
  their relative order after them, so an item someone added in the meantime is
  never lost. Unknown ids are ignored.
- **`update` with `baseVersion`:** this is how the editor saves. If someone else
  changed the item since you opened it, the update is refused and you get the
  current item back, so a phone edit and a desktop edit can't silently overwrite
  each other. `update` without `baseVersion` always wins; Claude uses that form
  after a fresh `list`.
- **Replays:** each add carries a fresh id. An add whose id is in the repo's `removed`
  list is a replay from a phone that reconnected, and is dropped. This is the same
  guard as `StoredDraft.removed`. The list is capped, like `MAX_REMOVED`.

## Storage (`src/main/backlog-store.ts`)

- One file, `configDir()/backlogs.json`, shaped as
  `Record<repoKey, { items, removed, rev }>`.
- **`repoKey` = the realpath of the bare repo** (`resolveBareRepo`, `cwd-tracker.ts:161`).
  That's the same identity `recent-repos.json` and `session:load` use, and it is
  the same for every worktree of the repo.
- Writes go to a temp file and then get renamed over the real one, and are cached
  in memory. This matches `screenprs-drafts.ts:93`.
- `rev` starts at `Date.now()` and goes up on every change, so a client can drop
  out-of-date answers even across an app restart.
- **No pruning by age.** Unlike review drafts, items aren't tied to a PR that can
  close, and they're the user's own typed work. They stay until someone removes or
  starts them.
- Invalid entries are dropped one by one on load (like `sanitize`). Socket input
  is rebuilt field by field with size limits (like `parseDraftOpRequest`).
- **The prompt cap is the session cap.** `session-create.ts` refuses any brief
  over `BRIEF_MAX` (8,000 characters, `:53`). Without a matching cap you could
  save an item that can never start. Move the constant to `src/shared/` and
  enforce it in the store, the editor (as a counter) and the MCP tool schema.

## IPC (namespace `backlog:`)

| Channel | Kind | Payload → result |
|---|---|---|
| `backlog:load` | invoke | `{ repo }` → `BacklogSnapshot` (`{ repo, items, rev }`) |
| `backlog:op` | invoke | `{ repo, op }` → `{ ok, snapshot } \| { ok: false, conflict, current }` |
| `backlog:start` | invoke | `{ repo, id, requestId, worktree? }` → `SessionCreateResult` |
| `backlog:changed` | event | `BacklogSnapshot`, sent to every window and phone |

The phone needs nothing extra. Any channel registered with `handleInvoke` can be
called from the phone (`ipc-registry.ts:40`), and `broadcastToAllClients` reaches
every connection. The phone always works with the primary repo of the window it's
attached to (`remoteAttachTarget`, `index.ts:260`). The channels take `repo`
explicitly, so letting the phone switch repos later only needs UI.

## Starting an item

The prerequisite is extending session creation. Today `session:create` only takes
`{ requestId, brief }`, and `createSessionFromBrief` always uses the default settings on
the main worktree (`sessions.svelte.ts:995`). The plan:

1. Add optional fields to `SessionCreateRequest`: `label`, `provider`, `model`,
   `reasoningEffort`, `worktreePath`, **`repoPath`**. Main checks that the window
   has `repoPath` open, and that `worktreePath` belongs to that repo (via
   `resolveWorktrees(window)`, the same check `spawn_session` uses).
2. The renderer's create handler uses these fields when present, and **sets
   `Session.repoPath`** so the workspace and session persistence point at the
   item's repo. Without it, an item from a secondary repo would open as a
   primary-repo session (`repoPath` undefined means primary). This shares code
   with `spawnSessionFromAgent` (`sessions.svelte.ts:1040`) for provider, model and
   worktree, but neither that function nor `createSessionFromBrief` (`:995`) sets
   `repoPath` today.
3. The phone's "new session" sheet keeps working unchanged, because every new field
   is optional.

`backlog:start` in main then does this:

1. **Check the `requestId` before looking up the item.** After a successful start
   the item is gone, so a replayed Start (the phone reconnecting) would otherwise
   fail with "not found" instead of returning the session it already created.
   `createSessionOnce` (`session-create.ts:110`) keeps a requestId → outcome cache,
   so a known requestId returns its cached result straight away.
2. **Per-item start lock.** Main keeps `starting: Map<itemId, requestId>`. A
   Start with a *different* requestId for an item that is already starting (desktop
   and phone tapping at once) is refused with "already starting". The lock is
   released when `createSessionOnce` settles: success, failure, or the 15 s
   `CREATE_ANSWER_TIMEOUT_MS` that produces `SESSION_CREATE_UNWITNESSED`.
   While an item is locked, its prompt and settings are copied once, and
   edits to it are refused, so the UI shows it as read-only "Starting…". An
   edit can't land after the copy and then vanish with the item.
3. Choose the worktree: the one passed to `backlog:start`, else the item's
   worktree, else **the main worktree of the item's repo** (not the window's
   primary repo). Desktop passes the worktree you have open, if it's in that repo.
4. Call `createSessionOnce` with the item's prompt, settings and `repoPath`.
5. Handle the outcome:
   - **Success:** remove the item, add its id to `removed`, broadcast the change, and
     return the result. The session reaches the sidebar the normal way.
   - **Failure** (e.g. the worktree is gone or the provider isn't installed): keep
     the item, set `lastStartError`, and broadcast.
   - **`SESSION_CREATE_UNWITNESSED`** (the request reached the window but was never
     confirmed): see Q2.

## MCP tools (Claude)

There are **two tools**. They mirror the store's ops, so reorganizing the backlog
takes one atomic call:

- `list_backlog()` → the items, in order, with ids and versions.
- `edit_backlog({ ops: BacklogOp[] })` applies a batch in one write. Example:
  "drop the stale ones, add two, re-sort by priority" becomes a single call.

**Which repo:** both tools take an optional `repo` argument, which can be any
absolute path inside the target repo; the agent usually passes its own working
directory. Resolution:
1. `repo` given → resolve it with `locateWorktree` (`mcp-bridge.ts:521`), which
   also registers a repo the window hasn't opened yet. That's the same reason
   `show_panel` takes an agent-supplied location.
2. Omitted → use the caller's worktree (`getWorktreeForTerminal`,
   `claude-stream.ts:106`) and then its repo (`resolveBareRepo`). That lookup
   returns null until a stream is attached, and may never be set for
   Codex/OpenCode. **If it's null, the tool returns an error asking for `repo`.**
   It never falls back to the window's primary repo, which could silently write
   to the wrong backlog.
3. The resolved repo must be one this window has open; otherwise the call is
   refused. **Every response names the repo it acted on**, so a wrong target
   is visible in the transcript.

The bridge answers straight from the main-owned store, with no round trip to
the renderer (`mcp-bridge.ts` `handleToolCall`). Tool descriptions
tell Claude to call `list` before `update`/`reorder`. They also say that writing
a backlog item is the alternative to `spawn_session` when the work should wait.

## Desktop UI

- **Entry point:** add `'backlog'` to `UiView` (`uiView.svelte.ts:6`), a branch in
  `App.svelte:213`, and a sidebar button above Screen PRs (`Sidebar.svelte:19`). A
  count badge shows how many items the current repo has.
- **`components/backlog/BacklogView.svelte`:**
  - A header with a repo switcher. It lists the window's repos and defaults to the
    active session's repo (`session.repoPath ?? primaryRepo()`).
  - The list: each row shows the label (or the prompt's first line), chips for
    provider/model and worktree, and Start / Edit / Delete buttons. Rows can be
    dragged to reorder, using native HTML5 drag-and-drop like
    `PaneTabBar.svelte:30-104`.
  - "+ New item" opens the editor.
- **`BacklogItemEditor.svelte`:**
  - A plain `<textarea>` for the prompt (see Q4).
  - A provider/model/reasoning picker, moved out of `HandoffComposer.svelte:135-152`
    into a shared `SessionTargetPicker.svelte`. HandoffComposer then uses it too.
  - An optional worktree select.
  - **Dropping files:** move `resolveDropPath`/`formatPaths` out of `Terminal.svelte:297-345`
    into `src/renderer/lib/dropped-paths.ts`. The editor inserts **plain paths**:
    relative when the file is inside the item's worktree, absolute otherwise. It
    does not use each provider's terminal format, because the provider can change
    after the drop, and the prompt is sent as an opening message, not typed into a
    TUI. Dropped data with no file path (an image from a browser, say) becomes a
    temp file through the existing `app:save-dropped-blob`.

## Phone UI

- **A new "Backlog" tab** next to Sessions and PRs. Add it to the nav types and
  stacks in `src/web/lib/nav.ts:17-45` and to `TABS` in `PocketApp.svelte:53`.
- **The list** shows the attached window's primary repo. Each row has Start (with
  a confirm step) and opens to edit. Swipe to delete, with undo.
- **The add/edit sheet** follows `NewSessionSheet` and reuses voice dictation. It has
  a prompt field and one optional "Model" row, defaulting to "Default". Reordering
  on the phone is long-press-drag, and can wait until after v1 (Claude or the
  desktop can sort).
- **The client store** (`src/renderer/stores/backlog.svelte.ts`) is shared by
  desktop and phone, the way `screenprs.svelte.ts` is. It applies ops to its own
  view straight away, queues ops that couldn't be sent and resends them on
  reconnect, and replaces its snapshot on `backlog:changed`.
- **The user's text is never dropped.** Two cases:
  - An `update` refused as a conflict, including one resent from the queue
    after a reconnect: the editor keeps the user's text and shows the conflict
    banner with "Keep mine" and "Take theirs".
  - An `update` for an item that was started or removed in the meantime: the
    editor offers "Save as new item".

  Either way the text stays in the editor until the user picks.

## Testing

- **Unit:** `applyBacklogOp` (reorder with missing or unknown ids, version
  conflicts, the replay guard, ops that change nothing); the store's load, sanitize,
  atomic write and `rev`; `backlog:start` (success removes the item, failure keeps
  it, a replay after success returns the same session instead of "not found",
  two concurrent starts create only one, an edit during a start is refused, an
  item from a secondary repo opens with that repo's `repoPath` and main worktree);
  prompts over the cap are refused.
- **Bridge:** `list_backlog` and `edit_backlog` in `mcp-bridge.test.ts`, including
  how the caller's repo is found: explicit `repo`, the fallback to the caller's
  worktree, an error when neither resolves, and refusal of a repo the window
  hasn't opened.
- **Browser (headless):** BacklogView reorder and the editor's file drop.
- **E2E (CI only):** add an item, Start it, the session appears, and the item is gone.
- Update CLAUDE.md (the Layout diagram, File structure, and the `backlog:`
  namespace) and add a changeset.

## Delivery

Two PRs, not a long stack:
1. **Core:** shared types and ops, the store, the IPC, the `session:create`
   extension, and the MCP tools. Usable straight away by Claude, with the desktop
   showing a minimal list.
2. **UI:** the full desktop view and editor, the extracted picker and drop
   helpers, and the phone tab.

## Open questions

1. **Can Claude start items?** I recommend no: Claude curates the backlog, and
   Claude already starts work through `spawn_session`. Leaving out a
   `start_backlog_item` tool keeps "when does this run" your decision.
2. **Unconfirmed starts** (`SESSION_CREATE_UNWITNESSED`): the session might exist.
   I recommend keeping the item with a warning ("may have started, check the
   sidebar") and letting you remove it. A duplicate session is cheap to close; a
   lost prompt can't be recovered.
3. **Phone repo scope:** is "the attached window's primary repo" enough for v1, or
   do you want a repo switcher on the phone from day one?
4. **Editor:** a plain textarea (light, and the same on the phone) or Monaco in
   markdown mode (consistent with the rest of the desktop, heavier)? I lean
   textarea.
5. **Claude Code `@path` mentions:** do they get resolved when they appear in the
   opening prompt passed at launch? If yes, the editor could insert `@relative/path`
   for Claude items. This needs a quick check before deciding.
