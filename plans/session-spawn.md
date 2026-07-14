# Plan: Session spawn & handoff

Status: draft (ideation in progress) · Branch: TBD (builds on `feat/screen-prs-composer` / `fanout`)

> One primitive — *spawn a new primary session seeded with either a thin brief or the full
> forked conversation* — surfaced as three actions (thin-brief handoff, full-context fork, and
> an agent-facing MCP tool). It gives the workflow a cheap way to escape a bloated context and
> replaces the worktree-targeting half of the old fork. Interactive session lifecycle;
> independent of the worker-role substrate in [bounded-tasks](./bounded-tasks.md).

## Motivation

**The driver is context cost.** Measured across real sessions: cache *reads* of an
ever-growing prefix are ~2/3 of spend (not misses, not sub-agent waits), and ~70% of that
prefix is stale `Read` output. On a Claude subscription the main session runs the **1-hour
cache**, which removes the only natural "cache went cold, restart" nudge — so a session grows
to 400–660k tokens over hundreds of turns and re-reads all of it every turn. The single
highest-leverage habit is: **start a fresh session per unit of work instead of continuing a fat
one.** Today SimpleEdit gives you no cheap way to do that without losing your place. This plan
adds it.

## The primitive already exists (verified)

Spawning a fresh primary session with an arbitrary opening brief is shipping code:

- `renderer/stores/sessions.svelte.ts:237` — `createClaude(launchDir, worktreePath,
  {resumeSessionId, model, initialPrompt, label})`. Mints the id in the **renderer**
  (`crypto.randomUUID()`, `:242`), forwards `initialPrompt` to the PTY (`:269`), then **prepends
  a standalone session and `select()`s it**.
- `shared/ipc-types.ts:144` — `initialPrompt` on **`ClaudeSpawnOptions`** (which `extends
  PtySpawnOptions`, `:139-151`) → IPC `claude:spawn`.
- `main/index.ts:460` → `main/pty.ts:222` `spawnClaudeTerminal` → `main/agents/claude.ts:145`
  `buildLaunch`, where `initialPrompt` becomes Claude's positional first message (`:192`).
- **Already used this way:** `renderer/components/screenprs/PrDetail.svelte:54` `discuss()` calls
  `createClaude(..., {initialPrompt: buildBrief(), label})` to open a primed session.

And full-conversation forking exists too: `main/agents/claude.ts:209` `buildForkLaunch` runs
`claude --resume <src> --fork-session`. Today it's wrapped by `main/claude-fork.ts`, which also
copies the session JSONL into a *target worktree's* project dir — the worktree-targeting part we
retire below.

So this plan is not "build a spawn mechanism." It is: **wire two new front-doors to
`createClaude`** (an MCP tool and a brief composer), **fold full-context fork into an in-place
action**, and **remove only the worktree machinery**.

## Design rationale: never summarize the transcript

The tempting design — "fork a session by condensing its chat into a handoff" — is a trap:

- If the session is **live and warm**, the agent already holds the context. Asking it to write a
  short brief and spawn a successor is nearly free — that's the MCP tool below. (And if you want
  the *whole* reasoning carried over, that's the full-context fork, no summary needed.)
- If the session is **stale**, condensing the chat means a model must *read the whole transcript
  back* — paying full freight to re-ingest the exact bloat we're escaping. Self-defeating,
  cloud or local.

Resolution for the thin-brief path: **a successor doesn't need what the previous agent *said*.
It needs the task, the current code state, and what's left — all durable artifacts.** So we
*assemble* a brief, we don't *summarize* a conversation:

- **Goal** — the session's seed prompt. ⚠️ Today this is *not* persisted on the `Session` record
  (`sessions.svelte.ts:28-111` stores no `initialPrompt`); it's only forwarded to the PTY. So we
  must **persist the seed prompt on the session record** (see Files) — otherwise the composer
  could only recover the goal by reading the JSONL, i.e. the transcript this plan forbids. This
  is a real prerequisite, not an aside.
- **Current state** — `git diff` since session start + the touched-files/repos trail
  (`mcp-bridge.ts:334` `session:repo-touch` / `cwd-tracker.ts`).
- **What's left** — `PLAN.md`, the open PR (`main/github/gh.ts` `getPrContext`/`getPrMeta`;
  `currentHandle:44`), any TODO.

Conversation-only decisions ("we chose X over Y because Z") are what artifacts miss. Fix: the
live agent writes those into `PLAN.md`/memory *during* the session, or you use full-context fork.

## Design: three actions, one primitive

| Action | Mechanism | Context carried | Use |
| --- | --- | --- | --- |
| **Handoff (thin)** | `createClaude({initialPrompt: brief})` | fresh + assembled/authored brief | cost-escape reset; stale restart |
| **Fork (full)** | `createClaude({resumeSessionId, forkSession})` in-place | the full forked conversation | warm divergent exploration (cost not a concern) |
| **`spawn_session` (MCP)** | bridge → `createClaude({initialPrompt})` | fresh + agent-authored brief | agent-initiated fan-out |

### 1. `spawn_session` — the MCP tool (agent entry point)

A fifth tool in `main/mcp-server/index.mjs`, alongside the existing four (`complete_task`,
`show_panel`, `open_worktree`, `show_diff`). All four act on the *current* session; this is the
first that **creates** one.

```
spawn_session({
  brief: string,                       // required — becomes initialPrompt
  label?: string,
  model?: string,                      // default: inherit caller's model (see note)
  target?: 'new-pane' | 'replace',     // default 'new-pane'
  worktree?: string,                   // default: current workspace
}) -> ok    // fire-and-forget
```

- **Fire-and-forget, no returned id.** The bridge is one-way: `mcp-bridge.ts` `handleToolCall`
  does `webContents.send(...)` and returns its status body immediately (`:142-181`; cf. the
  `agent-panel:open`/`agent-workspace:show-diff` routes at `:174`/`:250`) — it never awaits the
  renderer, and the id is minted renderer-side (`:242`). Returning `{sessionId}` would require a
  request/response round-trip the existing tools don't have; we don't add it in v1. (If an id is
  ever needed, mint it in main and pass it into `createClaude` — a later change.)
- Posts to the per-window bridge like the other tools, on a **new bridge→renderer action**
  (`spawn-session`) that invokes `createClaude({initialPrompt: brief, label, model, ...})`. The
  `webContents.send` per-window plumbing exists; only this route and its renderer handler are new.
- **Model default:** the bridge only knows `terminalId` (`getWorktreeForTerminal`); the model is
  renderer state. The renderer handler must resolve the caller's current model when `model` is
  omitted — spec'd, not assumed.
- **`target` semantics** — needs new position control (see §2, the layout is a flat session list,
  not "slots").
- **Discoverability is the UX bar, not polish.** The tool must fire when the human just says
  "spawn a new session" / "start a fresh agent on X" — *without* naming SimpleEdit or the tool.
  That is driven entirely by the MCP tool **name + description**: write the description around the
  natural phrasings and the *why* ("start a new primary Claude session seeded with a brief — to
  hand off or fan out work"), and reinforce with a one-line hint in the injected session context
  (project `CLAUDE.md` / the MCP server's own instructions). **Acceptance test:** it triggers on
  the bare phrasing; if we have to say "use `spawn_session`", the description failed — that's a
  bug, not a footnote.

### 2. `target` + the real layout

There is **no `WorktreePane`/`PaneManager`** (the `CLAUDE.md` map is stale). The layout is
`components/layout/` → `SessionWorkspace.svelte` / `WorkspaceManager.svelte` /
`TabContainer.svelte` / `PaneTabBar.svelte`; sessions are a **flat list grouped by `groupId`**
(`sessions.svelte.ts` `SessionGroup` at `:112`, grouping at `:105`). `createClaude` today takes
no group/position — it always prepends a standalone session and selects it.

- **`new-pane`** — new session in a new tab-group; the caller keeps running. The **fan-out** seam
  ([board](#deferred), Gap 3).
- **`replace`** — the *reset*: escape the fat context but stay in place. This requires the new
  session to take the **outgoing session's `groupId`/tab position**, which no primitive supports
  yet → `createClaude` must gain a `target: {groupId, index}` option. The dispose half is real:
  `close(id)` → `pty:kill` (`sessions.svelte.ts:333`). Confirm no in-flight tool call is lost on
  dispose (likely a confirm step).

Guardrail: this hands agents a *capability* (start a session), not a change to how any agent
works internally.

### 3. Brief composer + "Hand off" action (human thin-brief entry point)

A UI action that assembles an **artifact brief**, opens it in an editable composer, and on confirm
calls `createClaude({initialPrompt})` with `target: 'replace'`.

- **The human writes the directive; the composer supplies the context.** The brief is *not* fully
  automatic — the human types what the new session should *do* ("fix the bug in the timeline
  reducer", "rebase this PR and get it merged"). That directive is the reason for the restart. The
  composer only **prefills the supporting context** so the human doesn't hand-write it: the
  original goal (from the persisted seed prompt), a `git diff` summary, touched files, PLAN/PR
  pointers. Net `initialPrompt` = **human directive + assembled context**.
- **Invariant:** the brief stays small and must **not** re-embed file contents (or the fresh
  session starts fat again — the whole point). Context is *pointers and summaries*, not file bodies.
- **Home:** a **new `'Hand off…'` menu item** in `SessionList` (near `:185`), *alongside* the
  existing entry — which is renamed `'Fork into worktree…'` → **`'Fork'`** and now triggers the
  in-place full-context fork (§4). Two distinct actions, not one repointed entry.

### 4. Full-context fork becomes in-place; retire the worktree machinery

Keep the **fork-the-conversation** capability, but drop the worktree targeting. In an agent-first
model you fork a divergent line *in place / into a new pane* — not into a separate git worktree.

**Verified (v2.1.209):** the `--fork-session` launch flag still mints a *new independent,
full-context, resumable* session id with the source left intact. (Interactive equivalent is now
`/branch`, not `/fork`; separate surface, not the one we use.) And an in-place fork needs **no
JSONL copy**: Claude keys its session store by launch-cwd (`claude-paths.ts`
`claudeProjectDirName`), and an in-place fork stays at the same project root as the source, so the
source transcript is already in that project dir. (The worktree-fork copied it precisely because
`spawnForkedClaudeTerminal` launched in a *different* cwd.)

**Implementation — one spawn path, not two.** Fork goes through the same `createClaude` →
`claude:spawn` → `buildLaunch` path as every other spawn; do **not** keep a parallel fork path.
`buildLaunch` gains a fork branch: when `forkSession` is set, **mint a fresh claude-session-id and
add `--fork-session`** (mirroring the retired `buildForkLaunch` at `claude.ts:220-224`).
⚠️ It must **not** reuse the resume/append branch (`claude.ts:171-176`), which sets `sessionId =
resumeSessionId` + `--resume` alone — that is *continue* semantics and, per the explicit guard at
`claude-fork.ts:95`, silently **appends to the source session** instead of forking. A fork = a new
id **and** `--fork-session`; getting this wrong corrupts the parent. So `forkSession` is a distinct
new branch, not an overload of the existing `resumeSessionId` path.

**Grouping:** to keep fork and origin together, **create a new group containing both** (or add the
fork to the parent's group if it already has one). A lone session has `groupId === undefined` and
groups dissolve below two members (`dissolveIfOrphaned`, `sessions.svelte.ts:184`), so there is
usually no group to "inherit" — the fork must *form* one. Reuses the `target:{groupId,index}`
control from §2.

**Retire (all dead code once fork lives on `buildLaunch`):** `main/claude-fork.ts`,
`buildForkLaunch`, `spawnForkedClaudeTerminal` (`pty.ts`), the `claude:fork`/`claude:fork-result`
IPC, `ClaudeForkOptions`, the fork placeholder state machine
(`addForkPlaceholder`/`failFork`/`forking`/`forkError`), `ForkWorktreePicker.svelte` (+ test), and
`claude-fork.test.ts`. The placeholder UX existed for the slow JSONL-copy fork; an in-place fork is
a plain fast spawn and needs none.

## Files (provisional)

**New**
- `main/mcp-server/index.mjs` — add `spawn_session` tool (modified file; new tool).
- `main/mcp-bridge.ts` — new `spawn-session` bridge→renderer route + caller-model resolution.
- `renderer/lib/session-brief.ts` — artifact brief assembler (goal + diff + touched files + PLAN
  + PR); reuses `main/github/gh.ts` (`getPrContext`) and the diff/touched-files primitives.
- `renderer/components/sidebar/HandoffComposer.svelte` — editable brief → spawn (colocated with
  `SessionList`; no `components/session/` dir exists).

**Modified**
- `renderer/stores/sessions.svelte.ts` — **persist the seed prompt on the `Session` record**
  (prerequisite for the composer's "goal" without reading the transcript); add
  `target:{groupId,index}` to `createClaude` for `replace`; pass `forkSession` through to
  `claude:spawn`; handle `target:'replace'` (spawn-in-position + `close()` old); form the
  fork+origin group.
- `main/agents/claude.ts` — `buildLaunch` gains the **fork branch** (fresh session id +
  `--fork-session` when `forkSession` is set; distinct from the resume/append branch at `:171-176`).
- `shared/ipc-types.ts` — `spawn-session` action payload; add `forkSession` to
  **`ClaudeSpawnOptions`** (which already carries `initialPrompt` — not `PtySpawnOptions`).
- `renderer/components/sidebar/SessionList.svelte` — rename `'Fork into worktree…'` (`:185`) →
  **`'Fork'`** (now the in-place full-context fork); add a new **`'Hand off…'`** item opening the
  composer.

**Removed** (all dead once fork lives on `buildLaunch`)
- `main/claude-fork.ts` (+ `claude-fork.test.ts`), `buildForkLaunch` (`claude.ts:209`),
  `spawnForkedClaudeTerminal` (`pty.ts`), the `claude:fork`/`claude:fork-result` IPC
  (`ipc-types.ts:232`), `ClaudeForkOptions`, the fork placeholder state machine
  (`addForkPlaceholder`/`failFork`/`forking`/`forkError`), and `ForkWorktreePicker.svelte` (+ test).

## Build sequence

1. **Persist the seed prompt on the `Session` record** — small, and a prerequisite for the
   composer's artifact "goal". Unblocks §3.
2. **`spawn_session` MCP tool + `spawn-session` bridge route** (`target:'new-pane'`, fire-and-
   forget, caller-model resolution) — the keystone; reuses `createClaude`.
3. **`target:'replace'`** — `createClaude` gains `target:{groupId,index}`; spawn-in-position +
   dispose old. The in-place reset.
4. **Full-context fork in-place** — `buildLaunch` gains the fork branch (fresh id +
   `--fork-session`, distinct from resume/append); wire `createClaude({resumeSessionId,
   forkSession})` + form the fork/origin group; remove all worktree-fork machinery (Files → Removed).
5. **Artifact brief composer** (`session-brief.ts` + `HandoffComposer.svelte`); repoint the menu.

## Non-goals

- **Summarizing the transcript / paying to re-read a stale context.** The explicit anti-pattern
  this plan is designed around (full-context fork covers "carry everything" without a summary).
- **Influencing how an agent works internally** (e.g. forcing read-delegation). We provide spawn
  and fork capabilities; the agent's method is its own.
- **The task-per-session board (Gap 3).** <a id="deferred"></a>Fan-out over a checklist of
  independent items, each seeded via `spawn_session({target:'new-pane'})` — spawn-in-a-loop plus a
  board/tracking UI. Deferred to its own plan; this doc only lays the `new-pane` seam.
