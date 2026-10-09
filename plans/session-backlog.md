# Plan: Session backlog

Status: draft (design review, revised 2026-10-08 against main eac8d20) · Branch: `feat/session-backlog`

> Queue up session prompts per project and start them later from desktop or phone, with
> Claude able to curate the list. A backlog item is a deferred
> [`spawn_session`](./session-spawn.md) call: prompt plus model, provider and worktree.

## Goal

Each project (the repo SimpleEdit was opened on) gets a backlog of prepared session
prompts. You add, edit, reorder and remove items on the desktop or the phone, and
any agent in the project can add and curate them over MCP ("add this to our
backlog"). Only you **start** an item: that opens a new session with its prompt
and saved settings. The item then leaves the backlog, and the session shows up in
the sidebar like any other.

**Non-goals for v1:** a dashboard of running sessions, Queued → Running → Done columns,
linking an item to the session it became, templates that survive a start, and
scheduled or automatic starts.

## Decisions already made

| Decision | Choice |
|---|---|
| Scope | One backlog per **project**: the window's primary repo, the one SimpleEdit was opened on. Never a repo a session merely works in (see below) |
| Storage | Main-owned, in the app's SQLite DB (`db.ts`, see Storage), not a markdown file, because each item needs its own model |
| Clients | Mirror main the way agent threads do: main is the only writer, nothing is applied locally first |
| On start | The item is removed and the session appears in the session list |
| Who can add | Claude (MCP), the user on desktop, the user on the phone |
| Who can start | Only the user, on desktop and on the phone. Claude adds and curates; there is no start tool |
| Editor | Monaco (markdown) on desktop; a textarea with voice input on the phone |
| Prompt text | Sent verbatim. SimpleEdit never rewrites it (no `@path` or other provider syntax) |
| Entry point | A sidebar button above "Screen PRs" |

**Why per project, not per repo.** Sessions launch at the project root so they
share one Claude memory. An agent that starts in project X and then edits files in
repo Y is still X's agent; its "add this to our backlog" belongs to X's backlog,
and the session it later becomes must launch at X's root to see X's memory.
So the backlog follows the window, never the repo trail.

## Data model (`src/shared/backlog.ts`)

```ts
interface BacklogItem {
  id: string                 // minted by the client (`b_…`, like `newThreadId`); never reused
  prompt: string             // the new session's opening message
  label?: string             // sidebar name; defaults to one derived from the prompt
  provider?: 'claude' | 'codex' | 'opencode'   // omitted = the default provider
  model?: string             // omitted = that provider's default model
  reasoningEffort?: ReasoningEffort            // Codex only, same rule as spawn_session
  worktree?: string          // absolute path of one of the project's worktrees; omitted = picked at start time
  version: number            // goes up on every edit; used to detect conflicting edits
  createdAt: string
  createdBy: 'desktop' | 'phone' | 'agent'
  createdBySession?: string  // agent items: the label of the session that added it
  lastStartError?: string    // set when a start failed; cleared on the next edit or start
}

type BacklogOp =
  | { op: 'add'; item: NewBacklogItem; index?: number }
  | { op: 'update'; id: string; baseVersion?: number; patch: Partial<EditableFields> }
  | { op: 'remove'; id: string }
  | { op: 'reorder'; ids: string[] }
```

`parseBacklogOp` lives in `src/shared/` and rebuilds socket input field by field
with size limits, in the style of `parseThreadOp` (`shared/agent-threads.ts`). The
ops are applied **only in main**, inside one transaction; clients never apply them
(see "The client store"). An op that changes nothing reports no change, so main
skips the broadcast.

How each op behaves:
- **`reorder`:** ids you list come first, in your order. Ids you leave out keep
  their relative order after them, so an item someone added in the meantime is
  never lost. Unknown ids are ignored. Main computes the new order in memory and
  rewrites the project's `position` column in the same transaction (a backlog is
  dozens of rows, not thousands).
- **`update` with `baseVersion`:** this is how the editor saves. If someone else
  changed the item since you opened it, the update is refused and you get the
  current item back, so a phone edit and a desktop edit can't silently overwrite
  each other (`UPDATE … WHERE id = ? AND version = ?`). `update` without
  `baseVersion` always wins; Claude uses that form after a fresh `list`.
- **Replays:** an `add` whose id already exists is a no-op, and one whose id is in
  the project's tombstones is dropped. A client that retries an add after a lost
  answer therefore never duplicates or resurrects an item. Same guard as
  `thread_tombstones`.

## Storage (`src/main/backlog-store.ts`)

- Tables in the app DB (`main/db.ts`, `userData/config/simpleedit.db`, built-in
  `node:sqlite`), added as one migration appended to `MIGRATIONS`:
  - `backlog_items` (`id` PK, `project`, `position`, the item's fields, `version`),
    indexed on `(project, position)`.
  - `backlog_tombstones` (`project`, `id`).
- **`project` = the window's primary repo** (`getRepoForSender`, `index.ts:132`),
  the same key `recent-repos.json` and `session:load` use. Two windows open on
  the same project share one backlog. Main always derives it from the caller;
  no client or agent ever names it.
- `edit_backlog` batches and every op run inside `transaction()` (`db.ts`), so a
  batch is all-or-nothing.
- `rev` per project starts at `Date.now()` and goes up on every change, kept in
  memory like the threads store's `rev`, so a client can drop out-of-date answers
  even across an app restart.
- **No pruning by age.** Unlike review drafts, items aren't tied to a PR that can
  close, and they're the user's own typed work. They stay until someone removes or
  starts them.
- **The prompt cap is the session cap.** `session-create.ts` refuses any brief
  over `SESSION_BRIEF_MAX` (32,000 characters, `shared/brief.ts:15`). The store,
  the editor (as a counter) and the MCP tool schema enforce the same constant, so
  an item that can never start can't be saved.
- **Dependency:** `db.ts` comes from the agent-threads branch. It ships as its own
  small PR first (with `closeDb()` wired to quit), so this feature doesn't wait on
  agent threads. Whichever of the two features lands second appends its migration
  after the other's.

## IPC (namespace `backlog:`, its own `BacklogInvokeMap`/`BacklogEventMap`)

| Channel | Kind | Payload → result |
|---|---|---|
| `backlog:load` | invoke | `()` → `BacklogSnapshot` (`{ project, items, rev }`) |
| `backlog:op` | invoke | `{ ops }` → `{ ok, snapshot } \| { ok: false, conflict, current }` |
| `backlog:start` | invoke | `{ id, requestId, worktree? }` → `SessionCreateResult` |
| `backlog:changed` | event | `BacklogSnapshot`, sent to every window and phone; each client keeps only its own project's |

No channel takes a project: main resolves it from the sender, so a client can't
write to another project's backlog by mistake.

The phone needs nothing extra. Any channel registered with `handleInvoke` can be
called from the phone (`ipc-registry.ts:40`), and `broadcastToAllClients` reaches
every connection (`index.ts:327`). The phone is attached to one window, and so to
one project; its project picker (`ProjectSheet`, `remote/attach-target.ts`) is
exactly a backlog switcher. The phone has the full backlog, with no gaps. It
reloads on reconnect and on `remote:projects-changed`.

## Starting an item

The prerequisite is extending session creation. Since the phone's Discuss sheet
(3d609a6), `SessionCreateRequest` is `{ requestId, brief, target?: InteractiveTarget,
label? }` (`ipc-types.ts:813`), so provider, model, effort and label already travel.
What's missing is *where*: `createSessionFromBrief` (`sessions.svelte.ts:1157`)
always opens on `mainWorktree()`. The plan:

1. Add an optional `worktreePath` to `SessionCreateRequest`. Main checks that it
   is one of the project's worktrees (`resolveWorktrees(webContentsId)`, the same
   check `spawn_session` uses).
2. The renderer's create handler opens the session's workspace on it when
   present. Share that with `spawnSessionFromAgent` (`sessions.svelte.ts:1214`).
   No `repoPath`: a backlog session is a project session like any other, and
   launches at the project root.
3. The phone's "new session" and Discuss sheets keep working unchanged, because
   the new field is optional.

`backlog:start` in main then does this:

1. **Check the `requestId` before looking up the item.** After a successful start
   the item is gone, so a replayed Start (the phone reconnecting) would otherwise
   fail with "not found" instead of returning the session it already created.
   `createSessionOnce` (`session-create.ts:216`) keeps a requestId → outcome cache
   (`byRequestId`, with a TTL), so a known requestId returns its cached result
   straight away. A `retryable` failure is *not* cached (nothing started), so a
   retry with the same requestId really starts again, which is what we want.
2. **Per-item start lock.** Main keeps `starting: Map<itemId, requestId>`. A
   Start with a *different* requestId for an item that is already starting (desktop
   and phone tapping at once) is refused with "already starting". The lock is
   released when `createSessionOnce` settles: success, failure, or the 15 s
   `CREATE_ANSWER_TIMEOUT_MS` that produces `SESSION_CREATE_UNWITNESSED`.
   While an item is locked, its prompt and settings are copied once, and
   edits to it are refused, so the UI shows it as read-only "Starting…". An
   edit can't land after the copy and then vanish with the item.
3. Choose the worktree: the one passed to `backlog:start`, else the item's
   worktree, else the project's main worktree. Desktop passes the worktree you
   have open, if it is one of the project's.
4. Call `createSessionOnce` with the item's prompt (verbatim) and settings.
5. Handle the outcome:
   - **Success:** remove the item, add its id to `removed`, broadcast the change, and
     return the result. The session reaches the sidebar the normal way.
   - **Failure** (e.g. the worktree is gone or the provider isn't installed): keep
     the item, set `lastStartError`, and broadcast.
   - **`SESSION_CREATE_UNWITNESSED`**: see "Unconfirmed starts" below.

**Unconfirmed starts.** Main can't create a session itself: labels, model
defaults and terminal ids live in the window's renderer. So `createSessionOnce`
sends the request to the renderer and waits up to 15 s
(`CREATE_ANSWER_TIMEOUT_MS`) for its answer. If no answer comes, because the
window is busy, reloading or hung, the request was delivered but nobody saw the
outcome: the session may exist, or may not. That is `SESSION_CREATE_UNWITNESSED`.
Main deliberately doesn't retry, because a retry could start a second copy.
For the backlog: keep the item, mark it "may have started — check the sidebar",
and let the user remove or start it again. A duplicate session is cheap to
close; a lost prompt can't be recovered. This needs a hung renderer, so it should
be rare. Today a late answer from the renderer is dropped (`session-create.ts:184`).
Passing it on would let the item clear itself once the session turns up. That is
a small, optional addition, not needed for v1.

## MCP tools (Claude)

There are **two tools**. They mirror the store's ops, so reorganizing the backlog
takes one atomic call:

- `list_backlog()` → the items, in order, with ids and versions.
- `edit_backlog({ ops: BacklogOp[] })` applies a batch in one write. Example:
  "drop the stale ones, add two, re-sort by priority" becomes a single call.

**Which project:** the bridge is per window, so the tools act on that window's
project, wherever the calling agent currently works. No `repo` argument and no
lookup from the caller's cwd or worktree. An agent working in repo Y adds to its
own project's backlog, which is the point. Every response names the project, so
the target is visible in the transcript.

The bridge answers straight from the main-owned store, with no round trip to
the renderer (`mcp-bridge.ts` `handleToolCall`). Tool descriptions tell the agent
to call `list` before `update`/`reorder`.

**"Add this to our backlog."** This is the main way agents use the backlog. The
user asks, and the agent writes a self-contained prompt (with the context a
fresh session needs) and adds it with `edit_backlog`. The tool description says
to do this instead of `spawn_session` whenever the user wants the work to wait.
An added item records `createdBy: 'agent'` and the session that added it. The
desktop shows a small toast ("Added to backlog: <label>", with Edit) so the user
can read and change the prompt before it ever runs. The agent never starts it;
starting is the user's decision.

## Desktop UI

- **Entry point:** add `'backlog'` to `UiView` (`uiView.svelte.ts:6`, today
  `'workspace' | 'screenprs'`), a branch in `App.svelte:217`, and a sidebar button
  above Screen PRs (`Sidebar.svelte:19`). The memory view is a per-session mode
  reached from `RepoPicker`, so it doesn't compete for this spot. A
  count badge shows how many items the project has.
- **`components/backlog/BacklogView.svelte`:**
  - A header naming the project. No switcher: the window is the project.
  - The list: each row shows the label (or the prompt's first line), chips for
    provider/model and worktree, an "added by <session>" note on agent items, and
    Start / Edit / Delete buttons. Rows can be
    dragged to reorder, using native HTML5 drag-and-drop like
    `PaneTabBar.svelte:30-98`.
  - "+ New item" opens the editor.
- **`BacklogItemEditor.svelte`:**
  - A Monaco editor in markdown mode for the prompt, with a character counter
    against the cap.
  - A provider/model/reasoning picker, moved out of `HandoffComposer.svelte:135-152`
    into a shared `SessionTargetPicker.svelte`. HandoffComposer then uses it too.
    (The phone's `DiscussSheet` has its own model picker; the phone sheet below
    reuses that one rather than this.)
  - An optional worktree select.
  - **Dropping files:** move `resolveDropPath`/`formatPaths` out of `Terminal.svelte:302-343`
    into `src/renderer/lib/dropped-paths.ts`. The editor inserts **plain absolute
    paths**, as text the user can see and edit. Never relative paths, because
    the session launches at the project root, not in the worktree. Never a
    provider's own syntax (`@path`), because the provider can change after the
    drop and the prompt is sent verbatim. Dropped data with no file path (an image from a browser, say) becomes a
    temp file through the existing `app:save-dropped-blob`.

## Phone UI

- **A new "Backlog" tab** next to Sessions and PRs. Add it to `TabId` and the
  stacks in `src/web/lib/nav.ts:17-50` (which now also has `projects` and
  `discuss` layers) and to `TABS` in `PocketApp.svelte:67`.
- **The list** shows the attached window's project; the header names it, and the
  project picker switches it. Each row has Start (with
  a confirm step) and opens to edit. Swipe to delete, with undo.
- **The add/edit sheet** follows `NewSessionSheet`: a textarea with voice dictation
  (`VoiceComposer`) and one optional "Model" row, defaulting to "Default", using
  `DiscussSheet`'s picker. Reordering
  on the phone is long-press-drag, and can wait until after v1 (Claude or the
  desktop can sort).
- **The client store** (`src/renderer/stores/backlog.svelte.ts`) is shared by
  desktop and phone and follows `agentThreads.svelte.ts`, not the review-drafts
  store: it mirrors its project's snapshot, and every change goes to main as
  an op and comes back as a snapshot, dropped if its `rev` is older than what the
  mirror holds. Nothing is applied locally first and nothing is queued offline,
  so there is no client copy of the op logic to keep in sync. The phone reloads
  in `connection.onIdentity` (`src/web/main.ts`), next to drafts and threads,
  because a broadcast sent while the socket was down never arrives.
- **The user's text is never dropped.** The editor keeps its text until main
  confirms the save. Three cases:
  - The op failed (the phone is offline, main refused it): the text stays, with
    an error and a Retry. A retried add carries the same id, so it can't
    duplicate.
  - An `update` refused as a conflict: the editor keeps the user's text and
    shows the conflict banner with "Keep mine" and "Take theirs".
  - An `update` for an item that was started or removed in the meantime: the
    editor offers "Save as new item".

## Testing

- **Unit:** the store against an in-memory DB (`useDbForTests(openDb(':memory:'))`,
  as `agent-threads-store.test.ts` does): reorder with missing or unknown ids,
  version conflicts, the replay guard, ops that change nothing, a failing batch
  rolling back whole, and `rev`; `parseBacklogOp`; `backlog:start` (success removes the item, failure keeps
  it, a replay after success returns the same session instead of "not found",
  two concurrent starts create only one, an edit during a start is refused, an
  unwitnessed start keeps the item flagged, and the prompt reaches the session
  byte for byte);
  prompts over the cap are refused.
- **Bridge:** `list_backlog` and `edit_backlog` in `mcp-bridge.test.ts`: they act on
  the window's project even when the caller's cwd is in another repo, and agent
  adds carry `createdBy: 'agent'` and the session.
- **Browser (headless):** BacklogView reorder and the editor's file drop.
- **E2E (CI only):** add an item, Start it, the session appears, and the item is gone.
- Update CLAUDE.md (the Layout diagram, File structure, and the `backlog:`
  namespace) and add a changeset.

## Delivery

Two feature PRs, not a long stack, after a small prerequisite:
0. **App DB** (prerequisite, small): `db.ts` split out of agent threads, plus
   `closeDb()` on quit. Needed only by the store, so the rest of Core can start
   before it lands.
1. **Core:** shared types and ops, the store, the IPC, the `session:create`
   extension, and the MCP tools. Usable straight away by Claude, with the desktop
   showing a minimal list.
2. **UI:** the full desktop view and editor, the extracted picker and drop
   helpers, and the phone tab.

## Open questions

None. The review on 2026-10-09 settled all five: no start tool for agents ("add
this to our backlog" instead), unconfirmed starts keep the item flagged, the
backlog is per project (so the phone has all of it), Monaco on desktop with a
textarea on the phone, and prompts go verbatim.
