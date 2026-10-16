# Plan: Workflows (scripted multi-agent execution)

Status: draft · Branch: `feature/runs` (worktree `wt-runs`) · Mockup:
https://claude.ai/artifact/HsK89KKsAM7BzSZEvWEQoU

> A lead session turns a plan into a **workflow**: a JSON task graph SimpleEdit executes
> deterministically. Workers are real terminal sessions, hidden from the sidebar, shown as a
> graph in the lead's **Workflow** tab. The lead is only woken at judgment points. SimpleEdit
> owns lifecycle, visibility and fan-in; the agent owns decomposition and model choice.

## Motivation

Delegation already works: a lead can `spawn_session` and collect with
`send_message(wait_for_reply)`. What's missing:

- **Visibility.** Workers show up as unrelated sidebar sessions; nothing shows the shape of
  the work, who is blocked on the user, or why a task hasn't started.
- **Cost.** An agent-supervised delegation wakes the lead for every report. Each wake
  re-reads the lead's whole prefix, and long worker turns push it past the cache window. A
  workflow removes the lead from the loop except where judgment is needed.
- **Durability.** The shape of the work lives only in the lead's context; a compaction or
  restart loses it.

## Decisions (locked 2026-10-16)

- **Name: workflow.** The industry term for a task graph an engine runs deterministically
  (Temporal, GitHub Actions, Claude Code's Workflow tool). "Run" is taken by Screen PRs
  (CLAUDE.md, "Screen PRs: runs belong to the app"), "runner" by bounded agent tasks, and
  "orchestrator" by deep review. One word covers the definition and its execution.
- **The lead decides, SimpleEdit executes.** The user gives the lead input; the lead picks
  the split, dependencies and provider/model per task and encodes them in the workflow. The
  user does not configure tasks.
- **JSON, not code.** A workflow is data SimpleEdit validates (the `parseBacklogOps`
  pattern). It can be drawn before it executes and it is safe to execute in main.
  Expressiveness comes from a few task kinds plus **patching**: the lead can be woken and
  amend pending tasks, which a running script couldn't offer.
- **The plan stays prose.** `PLAN.md` is not parsed. The workflow is the lead's *derived*
  execution record, never an authoring surface (the lesson of Plan Mode, #132).
- **Every worker is a terminal session** the user can intercept and steer. No headless
  mode: the headless runners are read-only today (see Engine), so writing tasks would need
  a new write-capable mode per backend plus a fallback path in the UI when it fails. A
  hidden terminal worker already gives what headless promised (no sidebar noise, no
  attention unless it asks), and it costs the same tokens for the same model. The lead
  still picks provider and model per task, local models included.
- **Workers are hidden from the sidebar.** Their attention state rolls up onto the lead's
  row. The user can still open any worker's terminal from the graph in a popup.
- **The Workflow tab lives in the lead's session view**, beside PLAN.md / Diff, with the
  lead's terminal in the normal split below. No "wake lead" button: the user talks to the
  lead in its terminal.
- **A workflow is bound to the lead's window.** Only the renderer can create sessions
  (`session-create.ts:221-320`), so when that window closes the engine stops starting
  tasks, running ones continue, and the workflow shows `paused: window closed`. It resumes
  when the window reopens. No main-side session-create path.
- **Permissions are not a workflow concern.** No provider launch passes a permission or
  approval flag (`main/agents/*.ts`), so workers get the user's own CLI defaults (in
  practice auto mode). A rare prompt is an ordinary Needs you item.
- **Waking the lead at judgment points is fine** (rare by design). The workflow record is
  the durable memory, so the user may compact the lead once the workflow is prepared.
- **Visualization: layered graph.** Columns = dependency depth, cards carry status, a
  "Needs you" strip on top, loops as one card with a round counter, maps as stacked cards,
  patch additions highlighted, cancellations kept greyed. Phone: columns become sections.

## Concepts

- **Workflow**: `{id, leadSessionKey, goal, title, version, status, tasks[], patches[]}`,
  owned by main. Status: `draft` (prepared, not started) → `running` → `paused` | `done` |
  `failed` | `cancelled`.
- **Task**: a node in the graph. Common fields: `id`, `title`, `after: taskId[]`, `kind`,
  plus runtime state (`queued | running | waiting | done | failed | cancelled`,
  `sessionKey`, `result`, timestamps).
- **Patch**: an op batch from the lead (`add`, `update`, `cancel` on tasks), applied
  against the workflow's `version`. Every applied patch is kept (`patches[]`) so the UI can
  show what changed and when.
- **Judgment point**: a condition the engine can't decide alone (a failure under
  `onFailure: "escalate"`, a loop that didn't converge, a task that asked for the lead). The
  engine pauses the dependent subgraph and wakes the lead with one compact question.

### Task kinds (v1)

| kind | fields | semantics |
|---|---|---|
| `agent` | `brief`, `provider`, `model`, `effort?`, `worktree` (branch/path) | One worker session. Done when it reports a result. |
| `loop` | `worker` (an agent spec), `reviewer` (agent spec), `maxRounds` | Worker runs; a **fresh** reviewer reviews the diff; findings go back to the worker; repeat until the reviewer reports `clean` or `maxRounds` is hit (→ judgment point). |
| `map` | `over: "<taskId>.result.items"`, `template` (agent spec with `{{item}}`) | Fan-out sized at runtime from an earlier result. Renders as one stacked card. |
| `integrate` | an agent spec, `shape: "single" \| "stack" \| "separate"` | Fan-in: combine the branches of its `after` tasks into the planned PR shape. Conflicts are where workflows go wrong, so this is the task the user most often steps into. |

Briefs may reference earlier results (`{{task.<id>.result.summary}}`). Templates are lookups
only, no expressions. `onFailure: "retry" | "escalate"` per task.

## Worker result contract

There is no "task done" signal today, only turn ends (`handleTurnEnd`,
`main/mcp-bridge.ts:914-967`). `complete_task` is the Tour hand-off
(`mcp-bridge.ts:280-310`) and is not reused.

- **New MCP tool `report_result`** for workflow workers: `{status: done | failed |
  needs_lead, summary, branch?, changedFiles?, items?, verdict?: clean | findings,
  findings?}`. The bridge resolves the caller from `terminalId`
  (`mcp-server/index.mjs:60-98`) to a workflow task.
- A `Stop` without `report_result` means "turn ended, still working". A worker left idle
  without a result becomes `waiting` and shows in Needs you.
- The worker brief gets a standard footer (as `withSpawnerAddress` does today,
  `mcp-bridge.ts:242`): its workflow/task id, its acceptance criteria, and "finish with
  `report_result`".

## Architecture (verified against main @ 4afa9d4)

### Store: `main/workflow-store.ts` (copy of the backlog pattern)

- Template: the backlog (`main/backlog-store.ts:1-11`): op batches applied all or nothing in
  `transaction(getDb(), …)` (`:217-232`), `baseVersion` conflicts (`:132`, `:177`), one entry
  point shared by IPC and MCP (`setBacklogTools`, `main/index.ts:357`). Validation in a
  `parseWorkflowOps` beside the store (`parseBacklogOps` lives at `backlog-store.ts:347`).
- Migration 3: append to `MIGRATIONS` (`main/db.ts:18`; threads are 1, backlog is 2).
  Tables `workflows`, `workflow_tasks`, `workflow_patches`.
- IPC namespace `workflow:`; broadcast `broadcastToAllClients('workflow:changed')`, which
  reaches windows and phones. Snapshot per workflow, not global: workflows are larger than
  backlog items (the threads delta pattern, `agent-threads-store.ts:126`, is the fallback
  if that proves heavy).
- Channels registered via `handleInvoke` (`main/ipc-registry.ts:40`) are reachable from the
  phone automatically.

### MCP tools (`main/mcp-server/index.mjs` + `handleToolCall`, `mcp-bridge.ts:277`)

- `create_workflow({title, goal, tasks})` → a `draft` workflow owned by the calling
  session. Returns validation errors in a form the agent can fix.
- `patch_workflow({workflowId, baseVersion, ops})`: add/update/cancel. Only `queued` tasks
  can be updated. `cancel` on a running task stops its worker.
- `start_workflow({workflowId})`: the lead may start it, but the Workflow tab also has
  **Start**, so the user can review the graph first.
- `get_workflow({workflowId})`: compact status for a woken lead (no worker transcripts).
- `report_result(...)`: workers only (above).
- Exposed to Claude via `--mcp-config` (`agents/claude.ts:33-45`), Codex via `-c
  mcp_servers.simpleedit.*` (`agents/codex.ts:67-82`), OpenCode (`agents/opencode.ts:42`).
  The same server serves all three.

### Engine: `main/workflow-engine.ts`

- An event loop over the store: on any state change, start every task whose `after` tasks
  are `done`, subject to the per-backend concurrency gate (`agent-tasks/gate.ts:44-53`,
  local 1, cloud 4).
- Tasks spawn through the existing renderer path (`agent-session:spawn` →
  `spawnSessionFromAgent`, `renderer/stores/sessions.svelte.ts:1226-1285`) with a new
  `workflow: {workflowId, taskId}` field, hence the window binding above.
- **Why not the headless runners** (`createTaskExecution`, `agent-tasks/registry.ts:25-58`):
  every one is analysis-only today. Codex runs `--sandbox read-only` (`runner.ts:355-366`),
  OpenCode has edit/bash/task denied (`:443-460`), DirectRunner is text-only (`:306-326`),
  Claude runs `--print` with no permission flags (`:206-215`). Revisit only if hidden
  terminal workers prove too heavy, e.g. many parallel PTYs.
- **Loop rounds:** the reviewer is always a fresh hidden session over the worker's diff.
  Findings go back to the worker as mail (`agent-bus.ts` `enqueue` + `requestWake`,
  `agent-wake.ts:219`).
- **Waking the lead:** `enqueue` from a synthetic `workflow` sender
  (`agent-bus.ts:205-264` allows any `from` that isn't the recipient) + `requestWake`. It
  inherits the wake rules: Claude waits for `idle_prompt`, a keypress since the turn
  started blocks the wake, and delivery falls back to the `Stop` block. That's acceptable
  for rare judgment points.
- **Worktrees:** each writing task names a branch. The engine creates the worktree before
  spawning (to verify: reuse whatever `open_worktree` / the worktree picker uses).
  Read-only tasks (reviewers) run in the worker's worktree.
- **Restart:** on app start, `running` tasks re-attach to their restored sessions by
  workflow/task id.

### Session identity

- Terminal ids change on restore (`sessions.svelte.ts:1022`), so they are never stored.
  `workflow: {workflowId, taskId}` goes on the session and is persisted like `groupId`
  (`serializeSession`, `lib/sessionPersistence.ts:99`; `SerializedAgentSession`,
  `shared/ipc-types.ts:742`; `hydrateSession` `:202` → `addRestoredSession`
  `sessions.svelte.ts:974-1046`).
- The lead is identified by a stable key (its minted id or `providerSessionId`) for the
  same reason.

### Renderer

- **Sidebar:** filter sessions with `workflow` set out of `SessionList.svelte:16-41`.
  Roll-up: `sessionAttentionLevelFor` (`sessionAttention.svelte.ts:102`) merges the lead's
  summary with its workers' via `sessionsAttention()` (`lib/sessionsAttention.ts:20`). The
  lead's row gains a progress bar and "N need you". A worker's hidden workspace is never
  mounted because it is never selected, which avoids the double-view issue
  (`WorkspaceManager.svelte:62`).
- **Workflow tab:** a new `workflow` tab kind. Touch points: the `Tab` union
  (`stores/tabsStore.svelte.ts:14-78`, `tabIdFor` `:113-127`), `TabContainer.svelte:53-102`,
  `PaneTabBar.svelte:35-47`, `TabIcon.svelte:29`, `sessionPersistence.ts:36,:138`. Commit
  `2588afd` (Plan Mode removal) lists every place a tab kind touches. Opened automatically
  on `create_workflow`.
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

The phone reuses renderer stores directly (`web/main.ts:8,27-40`). A read-only Workflow
screen (sections per stage, Needs you on top, tap → worker terminal) follows the backlog's
shape (`web/BacklogScreen.svelte`, `web/PocketApp.svelte:78,704`). Push when a task enters
`waiting` or the lead is woken (`push.ts`).

## Delivery (few, larger PRs)

1. **Workflows core.** Store + migration, `create/patch/start/get_workflow`,
   `report_result`, engine (dependencies, `agent` + `integrate` kinds, `onFailure`
   retry/escalate), hidden workers + roll-up, Workflow tab graph + Needs you + popup,
   restart re-attach.
2. **Loops and maps.** `loop` and `map` kinds, patch history view.
3. **Phone.** Workflow screen, push on waiting / lead woken.

The final commit of the branch deletes this plan. Durable parts go into `CLAUDE.md`.

## Open questions

- **Who may start:** should `start_workflow` from the lead start immediately, or always
  wait for the user's Start in the Workflow tab? Proposal: user Start by default, plus an
  opt-in "lead may start" setting.
- **Cancelling a running task:** dispose the session, or detach it into a normal sidebar
  session the user can keep? Proposal: detach.
- **Workflow end:** when a workflow finishes, do its worker sessions get disposed, or
  archived and reachable from the Workflow tab? Proposal: kept until the workflow is
  dismissed.
- **Budgets:** a per-workflow cap on concurrent workers and total rounds beyond the backend
  gate.
