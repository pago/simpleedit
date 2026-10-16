# Plan: Runs (scripted multi-agent execution)

Status: draft · Branch: `feature/runs` (worktree `wt-runs`) · Mockup:
https://claude.ai/artifact/HsK89KKsAM7BzSZEvWEQoU

> A lead session turns a plan into a **run**: a JSON task graph SimpleEdit executes
> deterministically. Workers are real terminal sessions, hidden from the
> sidebar, shown as a graph in the lead's **Run** tab. The lead is only woken at judgment
> points. SimpleEdit owns lifecycle, visibility and fan-in; the agent owns decomposition and
> model choice.

## Motivation

Delegation already works: a lead can `spawn_session` and collect with
`send_message(wait_for_reply)`. What's missing:

- **Visibility.** Workers show up as unrelated sidebar sessions; nothing shows the shape of
  the work, who is blocked on the user, or why a task hasn't started.
- **Cost.** An agent-supervised run wakes the lead for every report. Each wake re-reads the
  lead's whole prefix, and long worker turns push it past the cache window. A script removes
  the lead from the loop except where judgment is needed.
- **Durability.** The run's shape lives only in the lead's context; a compaction or restart
  loses it.

## Decisions (locked 2026-10-16)

- **The lead decides, SimpleEdit executes.** The user gives the lead input; the lead picks
  the split, dependencies, provider/model and mode per task and encodes them in the run. The
  user does not configure tasks.
- **JSON, not code.** The run is data SimpleEdit validates (the `parseBacklogOps` pattern).
  It can be drawn before it executes and it is safe to run in main. Expressiveness comes
  from a few node types plus **patching**: the lead can be woken and amend pending tasks,
  which a running script couldn't offer.
- **The plan stays prose.** `PLAN.md` is not parsed. The run is the lead's *derived*
  execution record, never an authoring surface (the lesson of Plan Mode, #132).
- **Every worker is a terminal session** the user can intercept and steer. No headless
  mode: the headless runners are read-only today (see Runner), so writing tasks would
  need a new write-capable mode per backend plus a fallback path in the UI when it fails.
  A hidden terminal worker already gives what headless promised (no sidebar noise, no
  attention unless it asks), and it costs the same tokens for the same model. The lead
  still picks provider and model per task, local models included.
- **Workers are hidden from the sidebar.** Their attention state rolls up onto the lead's
  row. The user can still open any worker's terminal from the graph in a popup.
- **The Run tab lives in the lead's session view**, beside PLAN.md / Diff, with the lead's
  terminal in the normal split below. No "wake lead" button: the user talks to the lead in
  its terminal.
- **Waking the lead at judgment points is fine** (rare by design). The run record is the
  durable memory, so the user may compact the lead once the run is prepared.
- **Visualization: layered graph.** Columns = dependency depth, cards carry status, a
  "Needs you" strip on top, loops as one card with a round counter, maps as stacked cards,
  patch additions highlighted, cancellations kept greyed. Phone: columns become sections.

## Concepts

- **Run**: `{id, leadSessionKey, goal, title, version, status, tasks[], patches[]}`, owned
  by main. Status: `draft` (prepared, not started) → `running` → `paused` | `done` |
  `failed` | `cancelled`.
- **Task**: a node in the graph. Common fields: `id`, `title`, `after: taskId[]`, `kind`,
  plus runtime state (`queued | running | waiting | done | failed | cancelled`, `sessionKey`,
  `result`, timestamps).
- **Patch**: an op batch from the lead (`add`, `update`, `cancel` on tasks), applied
  against the run's `version`. Every applied patch is kept (`patches[]`) so the UI can show
  what changed and when.
- **Judgment point**: a condition the runner can't decide alone (a failure under
  `onFailure: "escalate"`, a loop that didn't converge, a task that asked for the lead). The
  runner pauses the dependent subgraph and wakes the lead with one compact question.

### Task kinds (v1)

| kind | fields | semantics |
|---|---|---|
| `agent` | `brief`, `provider`, `model`, `effort?`, `worktree` (branch/path) | One worker session. Done when it reports a result. |
| `loop` | `worker` (an agent spec), `reviewer` (agent spec), `maxRounds` | Worker runs; a **fresh** reviewer reviews the diff; findings go back to the worker; repeat until the reviewer reports `clean` or `maxRounds` is hit (→ judgment point). |
| `map` | `over: "<taskId>.result.items"`, `template` (agent spec with `{{item}}`) | Fan-out sized at runtime from an earlier result. Renders as one stacked card. |
| `integrate` | an agent spec, `shape: "single" \| "stack" \| "separate"` | Fan-in: combine the branches of its `after` tasks into the planned PR shape. Conflicts are where runs go wrong, so this is the task the user most often steps into. |

Briefs may reference earlier results (`{{task.<id>.result.summary}}`). Templates are lookups
only, no expressions. `onFailure: "retry" | "escalate"` per task.

## Worker result contract

There is no "task done" signal today, only turn ends (`handleTurnEnd`,
`main/mcp-bridge.ts:914-967`). `complete_task` is the Tour hand-off
(`mcp-bridge.ts:280-310`) and is not reused.

- **New MCP tool `report_result`** for run workers: `{status: done | failed | needs_lead,
  summary, branch?, changedFiles?, items?, verdict?: clean | findings, findings?}`. The bridge
  resolves the caller from `terminalId` (`mcp-server/index.mjs:60-98`) to a run task.
- A `Stop` without `report_result` means "turn ended, still working". A worker left idle
  without a result becomes `waiting` and shows in Needs you.
- The worker brief gets a standard footer (as `withSpawnerAddress` does today,
  `mcp-bridge.ts:242`): its run/task id, its acceptance criteria, and "finish with
  `report_result`".

## Architecture (verified against main @ 4afa9d4)

### Store: `main/run-store.ts` (copy of the backlog pattern)

- Template: the backlog (`main/backlog-store.ts:1-11`): op batches applied all or nothing in
  `transaction(getDb(), …)` (`:217-232`), `baseVersion` conflicts (`:132`, `:177`), one entry
  point shared by IPC and MCP (`setBacklogTools`, `main/index.ts:357`). Validation in a
  `parseRunOps` beside the store (`parseBacklogOps` lives at `backlog-store.ts:347`).
- Migration 3: append to `MIGRATIONS` (`main/db.ts:18`; threads are 1, backlog is 2).
  Tables `runs`, `run_tasks`, `run_patches`.
- Broadcast: `broadcastToAllClients('runs:changed')`, which reaches windows and phones.
  Snapshot per run, not global: runs are larger than backlog items (the threads delta
  pattern, `agent-threads-store.ts:126`, is the fallback if that proves heavy).
- Channels registered via `handleInvoke` (`main/ipc-registry.ts:40`) are reachable from the
  phone automatically.

### MCP tools (`main/mcp-server/index.mjs` + `handleToolCall`, `mcp-bridge.ts:277`)

- `create_run({title, goal, tasks})` → a `draft` run owned by the calling session. Returns
  validation errors in a form the agent can fix.
- `patch_run({runId, baseVersion, ops})`: add/update/cancel. Only `queued` tasks can be
  updated. `cancel` on a running task stops its worker.
- `start_run({runId})`: the lead may start it, but the Run tab also has **Start**, so the
  user can review the graph first.
- `get_run({runId})`: compact status for a woken lead (no worker transcripts).
- `report_result(...)`: workers only (above).
- Exposed to Claude via `--mcp-config` (`agents/claude.ts:33-45`), Codex via `-c
  mcp_servers.simpleedit.*` (`agents/codex.ts:67-82`), OpenCode (`agents/opencode.ts:42`).
  The same server serves all three.

### Runner: `main/run-runner.ts`

- An event loop over the store: on any state change, start every task whose `after` tasks
  are `done`, subject to the per-backend concurrency gate (`agent-tasks/gate.ts:44-53`, local
  1, cloud 4).
- **Terminal tasks** spawn through the existing renderer path (`agent-session:spawn` →
  `spawnSessionFromAgent`, `renderer/stores/sessions.svelte.ts:1226-1285`) with a new
  `run: {runId, taskId}` field. Only the renderer can create sessions
  (`session-create.ts:221-320`), so terminal tasks need the lead's window (see Open
  questions).
- **Why not the headless runners** (`createTaskExecution`, `agent-tasks/registry.ts:25-58`):
  every one is analysis-only today. Codex runs `--sandbox read-only` (`runner.ts:355-366`),
  OpenCode has edit/bash/task denied (`:443-460`), DirectRunner is text-only (`:306-326`),
  Claude runs `--print` with no permission flags (`:206-215`). Revisit only if hidden
  terminal workers prove too heavy, e.g. many parallel PTYs.
- **Loop rounds:** the reviewer is always a fresh hidden session over the worker's diff.
  Findings go back to the worker as mail (`agent-bus.ts` `enqueue` + `requestWake`,
  `agent-wake.ts:219`).
- **Waking the lead:** `enqueue` from a synthetic `runner` sender (`agent-bus.ts:205-264`
  allows any `from` that isn't the recipient) + `requestWake`. It inherits the wake rules:
  Claude waits for `idle_prompt`, a keypress since the turn started blocks the wake, and
  delivery falls back to the `Stop` block. That's acceptable for rare judgment points.
- **Worktrees:** each writing task names a branch. The runner creates the worktree before
  spawning (to verify: reuse whatever `open_worktree` / the worktree picker uses).
  Read-only tasks (reviewers) run in the worker's worktree.
- **Restart:** on app start, `running` tasks re-attach to their restored sessions by
  run/task id.

### Session identity

- Terminal ids change on restore (`sessions.svelte.ts:1022`), so they are never stored.
  `run: {runId, taskId}` goes on the session and is persisted like `groupId`
  (`serializeSession`, `lib/sessionPersistence.ts:99`; `SerializedAgentSession`,
  `shared/ipc-types.ts:742`; `hydrateSession` `:202` → `addRestoredSession`
  `sessions.svelte.ts:974-1046`).
- The lead is identified by a stable key (its minted id or `providerSessionId`) for the
  same reason.

### Renderer

- **Sidebar:** filter sessions with `run` set out of `SessionList.svelte:16-41`. Roll-up:
  `sessionAttentionLevelFor` (`sessionAttention.svelte.ts:102`) merges the lead's summary
  with its workers' via `sessionsAttention()` (`lib/sessionsAttention.ts:20`). The lead's row
  gains a progress bar and "N need you". A worker's hidden workspace is never mounted
  because it is never selected, which avoids the double-view issue (`WorkspaceManager.svelte:62`).
- **Run tab:** a new `run` tab kind. Touch points: the `Tab` union
  (`stores/tabsStore.svelte.ts:14-78`, `tabIdFor` `:113-127`), `TabContainer.svelte:53-102`,
  `PaneTabBar.svelte:35-47`, `TabIcon.svelte:29`, `sessionPersistence.ts:36,:138`. Commit
  `2588afd` (Plan Mode removal) lists every place a tab kind touches. Opened automatically
  on `create_run`.
- **Graph:** reuse `@xyflow/svelte` + `elkjs`, already in the app via
  `components/composed/Diagram.svelte` / `DiagramGraph.svelte`. ELK `layered` gives the
  column-per-depth layout. Cards are custom nodes. The Needs you strip and the patch
  history are plain Svelte above the graph.
- **Worker popup:** a modal with a second `<Terminal terminalId={worker}>`. Each instance
  builds its own xterm and replays `pty:backlog` (`Terminal.svelte:143-161`,
  `lib/pty-attach.ts:62`). Caveat: `pty:claim` sizing (`Terminal.svelte:75-78`): the popup
  claims size while open and must hand the claim back on close.
- **Intervention signal:** typing into a worker's popup marks the task `steered`; its
  `report_result` is passed on to the lead with that flag, so the lead doesn't treat the
  outcome as the worker's own call.

### Phone

The phone reuses renderer stores directly (`web/main.ts:8,27-40`). A read-only Run screen
(sections per stage, Needs you on top, tap → worker terminal) follows the backlog's shape
(`web/BacklogScreen.svelte`, `web/PocketApp.svelte:78,704`). Push when a task enters
`waiting` or the lead is woken (`push.ts`).

## Delivery (few, larger PRs)

1. **Runs core.** Store + migration, `create/patch/start/get_run`, `report_result`, runner
   (dependencies, `agent` + `integrate` kinds, `onFailure` retry/escalate), hidden workers +
   roll-up, Run tab graph + Needs you + popup, restart re-attach.
2. **Loops and maps.** `loop` and `map` kinds, patch history view.
3. **Phone.** Run screen, push on waiting / lead woken.

The final commit of the branch deletes this plan. Durable parts go into `CLAUDE.md`.

## Open questions

- **Name.** "Run" already means something in this codebase: a Screen PRs screening, deep
  review or overview is a "run" (CLAUDE.md, "Screen PRs: runs belong to the app"), and
  bounded agent tasks have runners. A distinct name for the feature avoids
  `run-store.ts` / `runner` confusion. Candidates: *plan run*, *job*, *flight*.
- **No window open:** tasks can't start without a renderer. Proposal: a run is bound to the
  lead's window; when that window closes, the runner stops starting tasks (running ones
  continue) and the run shows `paused: window closed`. Alternative: a main-side
  session-create path (larger change).
- **Permissions are not a run concern.** No provider launch passes a permission or
  approval flag (`main/agents/*.ts`), so workers get the user's own CLI defaults (in
  practice auto mode). A rare prompt is an ordinary Needs you item.
- **Who may start:** should `start_run` from the lead start immediately, or always wait for
  the user's Start in the Run tab? Proposal: user Start by default, plus an opt-in "lead may
  start" setting.
- **Cancelling a running terminal task:** dispose the session, or detach it into a normal
  sidebar session the user can keep? Proposal: detach.
- **Run end:** when a run finishes, do its worker sessions get disposed, or archived and
  reachable from the Run tab? Proposal: kept until the run is dismissed.
- **Budgets:** a per-run cap on concurrent workers and total rounds beyond the backend
  gate.
