# SimpleEdit — Claude Context

## Skills
- svelte-core-bestpractices

## Project overview
SimpleEdit is an Agentic Development Environment built with Electron + Svelte.
It targets engineers running Claude Code across multiple git worktrees in parallel.

The core insight: when you run agents across multiple worktrees, the engineer's
job shifts from *writing* code to *reviewing* code and providing direction. SimpleEdit
is built around that workflow — diff review, file highlighting, and Claude interaction
are first-class features, not afterthoughts.

## Conventions
- Bare repo at `simpleedit.git/`, worktrees alongside it
- Svelte 5 with runes (`$state`, `$derived`, `$effect`) — no legacy Options API
- Stores only for truly global state; prefer component-local runes otherwise
- TypeScript strict mode throughout
- Tailwind for styling (utility-first, no custom CSS unless unavoidable)
- `simple-git` for all git operations (never shell out for git)
- `node-pty` + `xterm.js` for the embedded terminal
- Monaco Editor for code editing (same engine as VS Code)
- `stream-json` Claude Code output consumed and parsed in main process, emitted via IPC
- All IPC channels defined and typed in `src/shared/ipc-types.ts`
- No `any` — use `unknown` + narrowing
- Use pnpm, never npm
- `node-pty` must be rebuilt for Electron after install (`electron-rebuild -f -w node-pty`)
- Preload outputs `.mjs` (not `.js`) due to `"type": "module"` in package.json

## Architecture layers
1. **Main process** (`src/main/`) — git, PTY, file-watching, IPC, recent repos
2. **Preload** (`src/preload/`) — typed contextBridge surface (`window.api`)
3. **Renderer** (`src/renderer/`) — Svelte app
4. **Shared** (`src/shared/`) — types used on both sides of the bridge

## Key architecture decisions

### Multi-window, per-window repo
Each window tracks its own bare repo path. The main process stores a
`Map<webContents.id, repoPath>` — IPC handlers route per sender.
When opening without `SIMPLEEDIT_REPO`, a Welcome screen shows recent repos
and a directory picker. Recent repos are stored in Electron's userData dir.

### Sessions are the primary entity (agent-first UI)
The sidebar is a flat list of **sessions** (`SessionList.svelte`), not worktrees.
A session is one PTY — Claude, an Agent View, or a plain terminal — plus the
workspace state that hangs off it. The session registry
(`stores/sessions.svelte.ts`, `Session` type) is the primary navigation store;
its `id` doubles as the PTY terminal id in main, so `pty:*` / `claude:*` IPC
routes work unchanged. Sessions can be organised into named, collapsible
**groups** (`SessionGroup`, browser-tab-group style): grouping is purely an
ordering invariant — every group's members are kept contiguous in the list by
`normalizeGroups`. Sessions are durable: restored-from-disk entries are
`pendingResume` placeholders with no live PTY until the user clicks Resume.

### Per-session workspace state (not global stores)
Each session owns its editor tabs (`tabsStore` keyed by session id), its
selected worktree, and its editor layout, all rendered by
`SessionWorkspace.svelte`. `WorkspaceManager.svelte` keeps every visited
workspace mounted (hidden, not destroyed) so switching sessions never loses
tabs, scroll positions, or the xterm buffer. Global stores
(`worktrees.svelte.ts`, `diffReview.svelte.ts`) are only for state that
genuinely crosses component boundaries (sidebar ↔ workspace).

### IPC namespace convention
All IPC channels use a `namespace:action` pattern. Each namespace maps to a
main-process module:
- `app:` — window/repo lifecycle (`index.ts`, `recent-repos.ts`)
- `worktree:` — git worktree management (`worktree.ts`)
- `pty:` — terminal/PTY management (`pty.ts`)
- `fs:` — file system operations (`file-watcher.ts`)
- `editor:` — file read/write + per-file watching for the editor (`editor-watcher.ts`)
- `git:` — git log, diff, commit inspection (`git-operations.ts`)
- `claude:` — Claude session spawn + stream parser (`agents/claude.ts`,
  `claude-stream.ts`, `pty.ts`)
- `memory:` — Claude auto-memory dir: resolve, health, file list, watch
  (`claude-memory.ts`, `memory-watcher.ts`)

### Claude Code integration (provider architecture)
The "✦ Claude" button in terminal tabs spawns `claude --output-format stream-json`
Interactive-agent launches go through a pluggable **provider** abstraction
(`main/agents/provider.ts`); Claude Code is the first and today only provider
(`main/agents/claude.ts`, which self-registers on import). A provider owns
everything agent-specific about a launch — the binary + flags, the
`--session-id`/`--resume`/`--fork-session` branching, the MCP gen-UI bridge
(`--mcp-config`) and the location-tracking hooks (`--settings`) — and produces a
`LaunchPlan` for the generic PTY layer (`pty.ts`).

Sessions are created from `WorkspaceManager.svelte` (Start Claude / Agents /
Terminal). `createClaude` in `sessions.svelte.ts` invokes `claude:spawn`;
Claude sessions launch at the **project root** (beside the bare repo) so all
sessions share one Claude memory, while the workspace viewer defaults to the
main worktree. The stream parser (`claude-stream.ts`) taps PTY output and reads
OSC titles for status, emitting:
- `agent:status` — the session's lifecycle state, per session in the sidebar.
  **The OSC title yields only `idle` and `running`** (`statusFromTitle`): ✳ is
  idle, a braille spinner is running, anything else is unrecognised. There is no
  title that means `waiting`, so a Claude session's blocked state arrives from
  the **`Notification` hook** instead (`writeHookSettings`), which is the only
  signal Claude Code emits meaning "I need you". Anything that acts on
  `waiting` — push notifications above all — depends on that hook being wired;
  `blocked-signal.test.ts` is what keeps every provider's path to `waiting`
  honest.
- `claude:file-touch` — file paths from Write/Edit/Read tool uses (highlighted in file tree)

**Fork** (in place, `sessionsStore.forkClaude`): branches a live session's whole
conversation into a fresh one via the normal spawn path — `buildLaunch` mints a
new id and adds `--fork-session` when `forkSession` is set (a fresh full-context
session, source left intact). No JSONL copy: the fork stays at the source's
project root, where the transcript already lives. Origin + fork are paired in a
group. **Hand off** (`HandoffComposer` + `session-brief.ts`) instead resets a
session onto a *fresh* context: it assembles a thin brief (goal + changed-file
summary + pointers, never file bodies) and spawns with `target: 'replace'`,
disposing the source. Agents reach the same primitive via the `spawn_session`
MCP tool.

### Session location & repo trail (hook-based)
Each spawned Claude session is launched with a `--settings` file
(`agents/claude.ts` `writeHookSettings`) wiring `UserPromptSubmit` +
`PostToolUse` + `Stop` + `Notification` HTTP hooks to the per-window bridge's
`/<token>/hooks` endpoint. (`Stop` serves agent messaging — see below;
`Notification` is the only route by which a Claude session reports `waiting`.)
`mcp-bridge.ts` `handleHook`
parses the body (`cwd-tracker.ts` `parseHookBody`) and drives the session's
"touched repos" trail — which feeds the **repo picker dropdown**
(`RepoPicker.svelte` → `touchedReposForSession`) and the worktree picker.

Two distinct signals, do not conflate them:
- **`cwd`** — where the agent *is*. Only changes on Bash `cd` / worktree tools.
  Emits `session:cwd`, which records the touch **and** repoints the workspace
  view (when the viewer is closed).
- **`tool_input.file_path`** (on `PostToolUse`) — a file the agent *read or
  edited*, which can live in a **sibling repo the cwd never entered** (Read/Edit
  /Write take an absolute path; they don't move the cwd). Emits
  `session:repo-touch`, which records the touch **only** — a glance at another
  repo must not yank the user's view.

A repo the window never opened is resolved on demand (`resolveBareRepo` →
`git rev-parse --git-common-dir`) and registered for the window. Gotcha: if you
only track `cwd`, cross-repo file reads/edits silently never appear in the
picker — that was the original bug (`e2e/session-repo-trail.test.ts`).

### Agent-to-agent messaging (`agent-bus.ts`)
Sessions can message each other: `list_sessions`, `send_message` (optionally
blocking on the answer), `reply`, `check_inbox`. `spawn_session` returns the new
session's id, so an agent can delegate and then collect.

**No new transport.** An agent SENDS via `/tool-call` and normally RECEIVES by
calling `check_inbox`. Two things get it to call that:
- **Idle wake (`agent-wake.ts`).** A session idle at its prompt fires no hooks,
  so when it has mail main submits a one-line `[SimpleEdit] … call check_inbox`
  notice into its PTY (`agentSubmitWrite`: bracketed paste + CR). It waits for
  the idle edge (`agent:status`, via `onAgentStatus`) plus `WAKE_SETTLE_MS`,
  and re-checks before writing; a `Stop` hook still being answered holds it
  (`beginStop`/`endStop`), since that hook may yet deliver by block. The
  notice carries no mail, so delivery stays a tool result. Each message
  justifies at most two notices; after that the `Stop` block delivers it.
- **`Stop` block.** When a turn ends with mail queued and the session can't
  be woken (always for Claude, see below), `handleTurnEnd` answers
  `{decision:'block', reason:<mail>}`, which both CLIs honour by continuing
  the turn. Claude Code renders this as a Stop-hook "blocking error".

Consequences worth knowing before touching this:
- **When in doubt, don't wake.** Queued mail reported honestly is always
  safe; an Enter typed into the wrong UI is not.
  - `pty:write` feeds `noteUserInput`. **Any** key since the last turn started
    rules a wake out, not just text: Up recalls history, Esc-Esc opens the
    rewind picker, `/model` + Enter leaves a picker up. Only what xterm sends on
    its own (focus, DA, cursor and mode reports, OSC/DCS replies) is ignored.
    The next real `running` clears it.
  - **A Claude session is woken only on its explicit idle-prompt signal**,
    never on its title going idle: the title reads idle under a permission or
    AskUserQuestion dialog too. Claude's `Notification` hook reports a prompt
    left idle for ~60 s with `notification_type: idle_prompt` (older CLIs: the
    exact message "Claude is waiting for your input"); only that sets
    `idleConfirmed`, and every new turn or `Stop` clears it. So a Claude
    session is woken up to a minute after its turn ends, and senders are told
    `confirming`. An `idle_prompt` that arrives once a turn is `running` is
    stale and ignored.
  - **A Claude `Stop` always delivers by block.** Its idle prompt needs a
    minute without interaction, so a user active in that session would starve
    mail left for a wake. The wake serves only mail that arrives after the
    `Stop`. (`canWake`, which lets a `Stop` defer, is false for Claude.) Codex (idle from its `Stop` hook) and OpenCode (its server's
    `session.status`) report idle explicitly, so idle alone suffices for them.
  - `waiting` of any other kind (permission, question, unknown) blocks wakes
    until the turn moves on (`running` or a `Stop`).
  - A notice the TUI swallowed is not retried (`noticeSent` until a turn
    starts); the mail stays `notified` until the next turn ends, and senders
    are told so.
  - Everything in the notice is stripped of control characters
    (`sanitizeLabel`; labels come from agents via `spawn_session`), and
    `agentSubmitWrite` strips paste markers until none are left.
- **No status, no wake.** `canWake` needs a reported status. Without one, idle
  can't be detected, so the `Stop` block delivers.
- **`stop_hook_active` must gate delivery.** That flag means the stop already
  belongs to a turn a hook continued; blocking again re-blocks the same turn and
  the agent never reaches idle (Claude hard-caps this at 8 blocks, then overrides).
  Mail left by such a stop is picked up by the wake.
- **`SubagentStop` is ignored.** A block there would hand the mail to the
  sub-agent, and its text is not the session's answer.
- **The reply channel is `last_assistant_message`** on the following `Stop`, so a
  peer answers *without calling any tool*. Only messages sent with
  `wait_for_reply` capture one, armed when the mail is handed over (`drain` /
  `commitDelivery`). A reply nobody is blocked on is queued and wakes its
  recipient like any other mail.
- **Each message has a state** (`queued` → `notified` → `delivered`, or
  `dropped` when its recipient goes away unread — logged, its waiter released,
  `agent-message:dropped` broadcast).
  `send_message`, `list_sessions` and the `wait_for_reply` timeout report it, so
  a sender can tell "recipient idle, being prompted" from "read, no answer yet".
  Every hand-over is logged as `[AgentBus] Delivered … via …`.
- **`spawn_session` appends the spawner's session id to the brief**, except for
  `target: 'replace'`, so a worker can report back without polling.
- **The renderer owns the peer list** (labels, provider, status), so it pushes
  snapshots via `agent-bus:sync`; main cannot derive them. Each peer belongs
  to the window that listed it: a window's sync only forgets its own, and a
  closed window's peers go with it (`forgetWindow`).
- **Hops carry across `send_message` too.** A fresh message continues the hop
  count of the mail that started the sender's turn (`chainHops`), so two agents
  answering each other without `reply` still stop at `MAX_HOPS`. A turn the
  user starts resets it. A reply that settles a sender's `wait_for_reply`
  counts as received mail too (`settleWaiter`).
- **The renderer syncs peers only once hydrated** (`markHydrated`): a
  reloaded window's list is empty until its sessions are restored, and that
  empty list would read as "all sessions gone" and drop their mail.
- Exchanges are bounded: hop budget, per-sender rate limit, message size cap.
  `agent-message:sent` / `:delivered` / `:dropped` drive the sidebar's
  unread-mail badge (`stores/agent-mail.svelte.ts`), seeded from
  `agent-bus:queued` on load.

### Screen PRs prompt overrides (`src/main/prompts/`)
Triage, each deep-review lens and the synthesis step build their prompt as
**instructions + contract + input**. Only the instructions are overridable, from
Settings → Prompts, as `userData/config/prompts/<id>.md` (frontmatter
`based-on: <id>@<defaultVersion>`). There are no placeholders: the output
contract (JSON/NDJSON shape) and the PR/diff framing are owned by the task
modules, so an override can't break parsing or drop the diff — the task tests
guard exactly that.
- `resolveInstructions(id)` reads the file on every run and falls back to the
  default on missing/empty/unreadable, recording `error` for Settings. A bad
  override never fails a run.
- The triage and deep-review cache fingerprints hash the **effective**
  instruction text, so editing an override or shipping a new default
  invalidates cached results without a version bump. `*_PROMPT_VERSION` still
  means "contract or input framing changed"; a registry entry's
  `defaultVersion` means "default instructions changed" and drives `outdated`.
- Resolve once per run and pass the text into the task factory, so the
  fingerprint and every model call see the same text.
- Adding a prompt = a `PromptId` member + one `PROMPTS` entry in `registry.ts`
  (plus a `PromptGroup` and its `PROMPT_GROUP_LABEL` heading if it needs a new
  Settings group — the pane derives its sections from that map). Ids
  arrive over IPC (the phone too) and become paths, so `promptDefinition`
  rejects anything unregistered.

### Phone companion: which window it borrows
A phone's socket joins one window's `ClientHub` (`remote/server.ts`), because
everything main knows about sessions is keyed by window id. Which window is
decided per connection by `remote/attach-target.ts`: the socket URL may name a
`window` + `repo` (the project the phone remembers, `web/lib/project.ts`), and
main honours the id only while that window still has that repo, then any window
with the repo, then the old focus rule. **Switching project is a reconnect**
(`RemoteConnection.reconnect`), never an in-place move of a live socket. The
close runs the same detach as a dropped connection: the hub unregisters it and
its PTY size claims are released. So no second teardown path exists to drift
from the first. The phone empties its Sessions tab whenever a `hello` names a
different window. It keeps the PRs tab, since Screen PRs and review drafts are
not per window.

### Claude memory view
"Claude memory" in a Claude session's repo picker shows the project's
auto-memory dir in the workspace (tree, editor, git log when tracked) with
health problems as Monaco markers and a badge.
- **An overlay, not a repoint.** `Session.memoryView` (never persisted) sets
  only the VIEW root (`viewRootFor`): file tree, palette files, and editors for
  files under the dir. `worktreePath` stays the real worktree, because agent
  spawn, cwd-follow, the repo trail and persistence read it. File tabs outside
  the dir keep the worktree as LSP root (clients are keyed per root).
- **Every exit goes through `leaveMemoryThen`** (Back, repo/worktree pickers,
  palette worktrees, MCP `open_worktree`). It closes memory file tabs and
  memory-scoped diff tabs and restores `viewerOpen` — leaving the viewer
  forced open would silently disable cwd-follow. It refuses while a memory
  file is unsaved (tab close discards edits) and the header says why; a
  refused agent repoint is dropped. `setActiveSessionWorktree` itself never
  touches the overlay, and neither does cwd-follow.
- **Locating the dir** (`claudeMemoryDir`): `autoMemoryDirectory` from USER
  settings only (a cloned repo's settings must not aim the editor/watcher at
  arbitrary dirs), else `<configDir>/projects/<key>/memory` for the first
  existing of: main worktree root, git toplevel, launch dir. `CLAUDE_CONFIG_DIR`
  / `CLAUDE_CODE_PROJECT_DIR_NAME` come from the login shell the CLI runs in
  (`claudeShellEnv`), not main's env. `memory:resolve` refuses `/`, `$HOME`,
  its ancestors and the config dir; the other `memory:*` channels only accept
  dirs it handed out (the phone can reach them).
- **Git mode** only when the dir is tracked, not ignored, and HEAD exists.
  GitLog then runs on the repo root with a pathspec (log, status poll, watch —
  a `~`-rooted repo would otherwise be walked every 3 s) and opens diffs with
  `memoryScope` (part of the tab id; files filtered, review/tour hidden).
  Without git, the health list takes GitLog's slot.
- **`stores/memoryView.svelte.ts`** holds a dir (refcounted): `memory:watch`,
  health + markers (`lib/memory-markers.ts`), and on `memory:changed` tree
  nonces, palette cache, health refetch, and a re-resolve (of every launch
  dir holding it) when dirs came or went. The dir's own removal ends main's
  watch (`watchEnded`); if it is back by the re-resolve, the store watches it
  again, since no `exists` flip will re-acquire it. Dir creation, `git init`
  and first commits fire no event, so the visible view polls `memory:resolve` (5 s while missing, 30 s while no-git).
- **Revealing an issue** switches a 'rendered' Markdown file to 'hybrid'
  (`markdownViewStore.setFor`) and uses `revealInEditor`, which tracks the path
  each editor has LOADED — one editor instance is reused across tabs, and
  re-opening the active tab never runs `loadFile`.

### Diff review flow
GitLog (in the session workspace) → click commit → `openDiffTab`
(`diffReview.svelte.ts`) → the session's `SessionWorkspace` opens a **diff tab**
rendering `DiffReview`. DiffReview uses Monaco's `createDiffEditor` for inline
diffs. "Uncommitted changes" entry compares working tree against HEAD.

### Screen PRs: the review diff
Screen PRs never shows or triages `gh pr diff` blindly. When a lower stack layer
is rebased, an upper PR still carries the lower layer's old commits, and GitHub's
diff (from the old merge-base) contains the whole stack. `github/stack-base.ts`
builds the **review diff** instead: for a PR whose base isn't the default
branch, it compares the PR's commits with the base's commits on top of the
default branch; matches are the lower layer's. If the PR's own commits are a
contiguous suffix, the diff is GitHub's compare from the last foreign commit to
the head; otherwise GitHub's diff is kept (stitching per-commit diffs repeats
file sections) and only the banner warns. Triage, deep review, both diff views
and the phone's `screenprs:pr-diff` all read this one diff. An isolated diff also
replaces the PR's +/−/files figures (`withReviewDiff`, applied on cache hits too,
since the figures are refetched each run); GitHub's move to `base.github`.

- **Match by subject + author date, never SHA.** The rebase that causes the
  problem rewrites every SHA; it keeps the subject and the author date. The date
  is what stops a recurring subject in both layers ("chore: update visual
  snapshots") from being mistaken for the lower copy.
- **The cache keys on the base too** (`baseKey`). A stacked PR's entry needs a
  matching `baseRefOid`: a rebased base changes the diff with the head untouched.
  A default-branch PR keys on the branch name only, because main advancing never
  changes its diff and keying on main's SHA would evict every entry on each merge.

### Screen PRs: the PR overview
The **Overview** button writes a reviewer's briefing of one PR (the `/pr-overview`
skill, in-app): What changed, Why, Impact, and a Look-into list of questions with
`path:line` citations. `pr-overview.ts` gathers the context, runs the task once and
caches the answer on the PR's screening entry.
- **Fixed-section markdown, not JSON or gen-UI.** The task runs in the runner's
  `output: 'text'` mode (the final assistant message, verbatim). The contract in
  `tasks/overview-task.ts` fixes the four headings and the citation form, and bans
  a preamble or header line; an override of prompt `overview` changes only the
  writing. The cache stores the **raw text** and `parseOverview`
  (`shared/pr-overview.ts`) splits it on every render, so a parser fix applies to
  cached overviews. Anything that doesn't parse renders whole, flagged
  "unstructured", so no output is lost.
- **Code renders the facts, never the model:** author, draft/ready, reviews, CI and
  changeset in `OverviewCard`'s header, the stale-base banner, and the actions.
  The input marks the current user's own comments "(you)" so the prose can say
  "you noted".
- **One ~150 KB input, filled in priority order** (`renderOverviewInput`): meta +
  review diff, commits, linked issues, discussion, changeset, CI, existing
  findings, key files at the head SHA and on the default branch (always
  `?ref=`-pinned), nearest CLAUDE.md. The caps add up to more than the budget, so
  the tail is what a big PR loses. The findings sit ahead of the files because
  they are small and are what stops Look into repeating triage. Each source also
  has its own cap, so a big diff can't starve the discussion. Whatever is cut or failed to fetch is listed in a `<not-seen>`
  block, so the model says "not seen" instead of guessing.
- Citations jump via `reveal(path, line?)` on `UnifiedDiffView` and the phone's
  `PrDiff`. Models shorten paths, so a citation resolves to the one diff path that
  ends with it (`resolveRefPath`).

### Screen PRs: review drafts and posting
The review composer's draft (line comments + summary + verdict) is the user's
typed work, so it is **owned by main** (`screenprs-drafts.ts`, one JSON file
under `userData/config`), not by a client. Desktop windows and phones mirror it
(`stores/screenprs.svelte.ts`) and change it only through ops
(`shared/review-drafts.ts`); main applies, persists and broadcasts
`screenprs:draft-changed` to every window and remote client.
- **Ops, never whole-draft writes**, and comments are addressed by a stable
  `id`. That is what lets two clients edit one draft without clobbering.
- **Main validates every op** (`parseDraftOpRequest`) — the phone is a remote
  client and the result is written to disk. `undefined` counts as absent:
  Electron's structured clone keeps `undefined` keys, JSON drops them.
- **Removed ids are tombstoned** per draft (`removed`, newest 500, kept even once
  the draft empties). A phone resends unacknowledged ops on reconnect; without
  tombstones a replayed add resurrects a posted or deleted comment.
- **A post clears only what it posted** (`clear-posted`: those ids, and the
  summary/verdict only if unchanged), and only when the caller passes
  `clearDraft`. Absent means keep — quick approve posts a separate review.

Posting (`github/review.ts`) pins the review to the head the user read
(`commit_id`) and checks **each** anchor against GitHub's PR diff at that head
(`commentableLines`, `resolveAnchor`): one unplaceable comment folds into the
body alone, keeping file:line and its snippet. Comments stamped with another
head fold too (`anchorsForHead`). LEFT anchors fold on an isolated stacked diff,
whose old side is a different base than GitHub's. The 422 all-fold retry keeps
`commit_id`; if GitHub refuses that, nothing is posted — an unpinned APPROVE
would approve code the reviewer never saw.

### Screen PRs: runs belong to the app
A screening, and each PR's deep review and overview, is **one run for the whole
app**, reported to every window and phone (`everyClient` in `client-hub.ts`,
built over the hubs and `liveWindowContents`), never to the hub that started it.
That is what lets a phone switch project mid-run.
- **One screening app-wide, one deep review and one overview per PR url.** A
  second start with identical parameters joins (`{ joined: true }`) and catches
  up with `screenprs:state`. One that differs (screening filters or `force`; a
  PR's head SHA or prompt/model fingerprint) replaces the run: main stops it and
  starts the new one, and every client sees both. The filter is shared, so the
  last start wins.
- **Any client can stop it**, and main reports the stop (`cancelled` for a
  screening, `idle` for a deep review or overview). Every send checks the run is
  still current, so a stopped run's stragglers never mix into the next one. A
  `running` status always means a fresh start, so clients drop that PR's old
  lenses, findings or overview on it.
- **Stop and quit kill the run's `gh` children.** `withGhSignal`
  (`github/gh.ts`) hands the run's abort signal to every `runGh` beneath it;
  a surviving `gh` would hold up quit.
- **Main keeps the board** (`screeningSnapshot`, `deepReviewSnapshot`,
  `overviewSnapshot`) for a client that missed the events: the desktop store
  loads it at start, the phone on every (re)connect. A socket client's copy has
  the diffs emptied, as its events do.
- A review post is the exception: its answer comes back on the invoke, over one
  connection, so the phone's picker still refuses a switch while one is in
  flight.

### Screen PRs: the saved filter and Discuss with Agent
The org + activity cutoff is **one saved filter owned by main**
(`screenprs-filter.ts`, `userData/config/screenprs-filter.json`), the same
shape as the drafts: `screenprs:filter-get`/`-set`, a revisioned snapshot, and a
`screenprs:filter-changed` broadcast to every window and phone. The store
mirrors it (`screenPrsStore.filter()`), and `start()` always screens with it.
Main validates every set (`parseFilterPrefs`) and every `screenprs:start`
(`parseScreeningFilters`: an object, a GitHub-legal owner, a real date): both
reach `gh` as arguments, and the phone is a remote client.

Discuss with Agent sends one brief from both clients (`shared/pr-brief.ts`). The
phone starts it through `session:create` with an explicit `target` and fixed
`label`, which main validates (`parseCreateTarget`, `parseCreateLabel`; a Claude
model never carries an Ollama endpoint from a socket) under the same
exactly-once `requestId` rule as the `+` sheet. A named model must be one the
picker offers (`unknownModelReason` against main's own catalogs), so a bad id
is refused where the phone sees why rather than dying at launch. A remembered
`requestId` that comes back with a different request (fingerprint of brief,
target, label) is refused (`SESSION_CREATE_REUSED`), so a client resends an
intent unchanged. On a project switch the phone drops the old window's
sessions from both tabs (`nav.ts` `leaveWindow`). The new session is pushed onto
the **PRs tab's** stack, so Back returns to the PR. A session's screen lives on
one stack at a time: asked for from the other tab or a notification, it is
shown where it already is, as the same entry (`nav.ts` `bringToFront`), so its
screen stays mounted and two terminals never attach to one PTY.

### Phone companion: remote access and the access key
`src/web/` is the phone app, served by `remote/server.ts` and talking to main
over one WebSocket that speaks the renderer's IPC channels (`api-shim.ts`).
Its security rule, which `server.ts`'s header states in full:
- **The key is per server start** (32 random bytes, never persisted) and it
  gates the **WebSocket** (`/app/ws?k=<key>`, constant-time compare). The
  socket is the only way to any IPC channel, event or data.
- **Only the static shell is public**: the built bundle under `/app/`, served
  without the key because it is the same for everyone and holds no data. That
  is what gives an installed app a scope that survives a restart. The shell's
  two varying responses (index.html's manifest link, the manifest's
  `start_url`) only echo the request's own `?k=`, so an iOS install saves it.
  `/app/auth?k=` answers one bit (204/401) so the app can tell a stale key from
  an unreachable Mac. Anything outside the bundle is a 404 (one containment
  check on the decoded, resolved path); a pre-#190 `/<key>/` link redirects to
  `/app/?from=legacy`. Shell responses forbid framing (`X-Frame-Options`,
  `frame-ancestors`) and cross-origin no-cors loads (`CORP: same-origin`), so
  another site can neither frame the scanner nor probe for SimpleEdit.
- Origin: any `Origin` must name the host the request addressed (forwarded
  headers trusted from loopback only, for `tailscale serve`); the upgrade must
  carry one. Bind rules: explicit host, loopback by default, never `0.0.0.0`.
- **Recovery is in-app.** On iOS the Camera opens Safari, whose storage is
  separate from the Home Screen app's, and leaving the scope opens an in-app
  browser — so the app keeps its key in its own `localStorage`
  (`lib/remote-key.ts`: a rescanned key outranks the start URL iOS replays,
  and a new URL key replaces a stored one only once `/app/auth` confirms it,
  so an old bookmark or a planted link can't knock a device off) and
  `PairScreen` scans (BarcodeDetector, else jsQR) or takes a pasted link, then
  `connection.setKey` reconnects without navigating. Only same-origin links are
  accepted, so recovery needs a stable origin: Serve's HTTPS name, or a fixed
  port.
- **Push carries no key** (`withoutKey`): the subscription and the worker's
  `/app/` scope don't depend on it, so push survives a key change.

### Layout
The sidebar (`SessionList`) picks the active session; `WorkspaceManager` renders
that session's `SessionWorkspace` (all others stay mounted but hidden). A
workspace starts as a **full-bleed terminal**; opening its viewer splits it into
an editor area (tabs + Monaco / diff / markdown / composed panels) with the file
tree and git log docked on the right, over a bottom terminal strip.

```
┌─ Title bar (drag region, repo name) ─────────────────────┐
├─ Sidebar ──┬─ SessionWorkspace (active session) ─────────┤
│ Sessions   │ Editor tabs (PaneTabBar + TabContainer)  │ F │
│ (grouped)  │ ──── file tree / git log docked right ─── │ T │
│ + Screen   │ ════════════ resize ════════════════════  │ + │
│   PRs view │ Terminal (full-bleed until viewer opens)   │Git│
└────────────┴─────────────────────────────────────────────┘
```
File tree is on the right (unusual but intentional — editor is the primary focus).
All splits are user-resizable. (`ScreenPrsView` replaces the workspace area when
the screen-PRs view is active — `uiView` store.)

## File structure

Key modules only — not exhaustive; `ls src/` for the full tree.

```
src/
  main/
    index.ts           ← App lifecycle, IPC registration, per-window routing
    pty.ts             ← node-pty manager (spawn, write, resize, kill)
    agents/
      provider.ts      ← Pluggable interactive-agent provider interface
      claude.ts        ← Claude Code provider (flags, resume/fork, MCP + hooks)
    claude-stream.ts   ← stream/OSC parser, PTY data tap, status
    claude-paths.ts    ← Claude project/JSONL path helpers + memory dir resolution
    claude-memory.ts   ← memory:* — resolve, git mode, bounded walk, health
    memory-watcher.ts  ← Refcounted chokidar watch of a memory dir
    cwd-tracker.ts     ← Parses hook bodies → session cwd / repo-touch trail
    agent-bus.ts       ← Agent-to-agent messaging: peers, mailboxes, replies
    agent-wake.ts      ← Prompts an idle session with mail to call check_inbox
    mcp-bridge.ts      ← Per-window HTTP bridge: MCP tool-calls + hook endpoint
    mcp-server/
      index.mjs        ← Stdio MCP server ("simpleedit" tools) → posts to bridge
    worktree.ts        ← simple-git worktree operations
    worktree-watcher.ts ← Watches for worktree add/remove
    file-watcher.ts    ← chokidar + file I/O
    editor-watcher.ts  ← Per-editor file change watching
    git-operations.ts  ← commit log, diff, file-at-commit, staging
    github/gh.ts       ← gh CLI wrapper (screen-PRs)
    github/pr-overview-context.ts ← PR overview context + input budget
    github/stack-base.ts ← Stacked-PR base analysis + the review diff
    screenprs.ts, screenprs-cache.ts ← Screen-PRs data + cache
    screenprs-drafts.ts ← Persisted review drafts (main owns them; desktop + phone mirror via ops)
    screenprs-filter.ts ← Persisted Screen PRs org + cutoff (main owns it; desktop + phone mirror it)
    review.ts, deep-review.ts, tour.ts ← Review/tour features
    pr-overview.ts     ← PR overview run + cache (screen-PRs)
    tasks/, agent-tasks/ ← Bounded agent-task orchestration (gate, runner)
    models/            ← Model catalog (Claude cloud + Ollama) + recommendations
    prompts/           ← Overridable prompt-instruction registry + userData overrides
    config-dir.ts      ← `userData/config[/sub]` helper for persisted state
    lsp-manager.ts     ← Language-server management
    remote/server.ts   ← Phone companion server: public shell under /app/, key-gated socket
    session-store.ts   ← Session persistence (durable sessions)
    recent-repos.ts    ← Recently opened repos (persisted JSON)
  preload/
    index.ts           ← Typed contextBridge (invoke, on, once)
    index.d.ts         ← Global window.api type declaration
  renderer/
    App.svelte         ← Root: Welcome screen or Sidebar + WorkspaceManager
    main.ts            ← Svelte mount + Monaco worker setup
    app.css            ← Tailwind import + drag-region CSS
    monaco-setup.ts    ← Monaco web worker registration
    components/
      Welcome.svelte          ← Repo picker + recent repos
      sidebar/
        Sidebar.svelte        ← SessionList + screen-PRs toggle
        SessionList.svelte    ← Flat, groupable list of sessions (primary nav)
        HandoffComposer.svelte ← "Hand off…" brief editor → replace-in-place spawn
        WorktreeList.svelte, GitLog.svelte ← Worktree list + commit log
      layout/
        WorkspaceManager.svelte ← Switches/keeps-alive per-session workspaces
        SessionWorkspace.svelte ← One session's editor + tree + git log + terminal
        TabContainer.svelte     ← Renders the active tab's body (editor/diff/…)
        PaneTabBar.svelte       ← Editor tab bar (reorder, pin, close)
        TabActions.svelte, TabIcon.svelte ← Tab chrome
        RepoPicker.svelte       ← Repo/worktree picker (touched-repos trail)
        ViewModeToggle.svelte
      editor/
        CodeEditor.svelte       ← Monaco editor wrapper
        DiffReview.svelte       ← Commit/staging review with file list
        MonacoDiffEditor.svelte, CompactDiffEditor.svelte ← Monaco diff wrappers
        MarkdownView.svelte, MarkdownPreview.svelte ← Markdown rendering
        AgentPopover.svelte, ReviewPanel.svelte, TourPanel.svelte
      terminal/
        Terminal.svelte         ← xterm.js instance
      filetree/
        FileTree.svelte, FileNode.svelte, FileTreeContextMenu.svelte
      composed/               ← Gen-UI composed panels (agent-authored) + registry
      screenprs/              ← ScreenPrsView, PrDetail, ReviewComposer, OverviewCard, …
      settings/               ← SettingsWindow, ModelsPane, DefaultModelPane, …
      command-palette/        ← CommandPalette + input/results
      memory/                 ← Memory health badge/list + empty state
    stores/
      sessions.svelte.ts      ← Session registry + groups (PRIMARY nav store)
      tabsStore.svelte.ts     ← Per-session editor tabs (keyed by session id)
      worktrees.svelte.ts     ← Worktree list, project root, repo routing
      diffReview.svelte.ts    ← Diff/tour tab opening
      claude-status.svelte.ts ← Per-session Claude status + touched files
      agentTerminals.svelte.ts ← "Discuss with Agent" targets (live Claude sessions)
      screenprs.svelte.ts, reviewStore.svelte.ts ← Screen-PRs + review state
      uiView.svelte.ts, commandPalette.svelte.ts, tourStore.svelte.ts
      markdownView.svelte.ts, fsRefresh.svelte.ts
      memoryView.svelte.ts    ← Open memory dirs: watch, health, markers, re-resolve
    lib/                      ← sessionPersistence, session-brief, agent-message, branchName, …
  shared/
    ipc-types.ts       ← All IPC channel type definitions
    git-types.ts       ← Re-exports from ipc-types
    gen-ui-catalog.ts, screenprs.ts ← Shared gen-UI + screen-PRs types
    pr-overview.ts     ← parseOverview (fixed-section parser) + overview types
    memory-health.ts   ← analyzeMemory: broken index links, unindexed files, [[wiki]] links
```

## E2E repro workflow

When asked to fix a bug, reproduce a problem, or verify a change, **always write an E2E test** — don't just make the change and declare it done.

### When to write a repro test
- User describes a bug or unexpected behaviour
- You're about to make a non-trivial UI or IPC change
- You want to confirm a fix actually works end-to-end

### Scratch file convention
Write ad-hoc tests to `e2e/repro.test.ts`. This file is a scratch pad — not committed unless you promote a test to a permanent file (e.g. `e2e/ide.test.ts`).

### Fixture cheat-sheet
```ts
// Welcome screen (no repo needed)
import { test, expect } from './fixtures'

// IDE layout (requires a bare repo)
import { makeRepoTest, expect } from './fixtures'
const REPO = process.env.SIMPLEEDIT_TEST_REPO!
const test = makeRepoTest(REPO)
test.skip(!process.env.SIMPLEEDIT_TEST_REPO, 'Set SIMPLEEDIT_TEST_REPO')
```

### Run commands
```bash
# Build + run repro test only
pnpm test:e2e:build -- repro.test

# Skip rebuild if app is already built
pnpm test:e2e -- repro.test

# Run with a repo
SIMPLEEDIT_TEST_REPO=/path/to/repo.git pnpm test:e2e -- repro.test
```

### After the test passes
- If it covers a regression worth guarding: move it to the appropriate permanent test file.
- Otherwise, delete `e2e/repro.test.ts` before committing.

## Adding changesets

Never run `pnpm changeset` — it's interactive and will hang. Instead, create the file directly:

```bash
cat > .changeset/short-description.md << 'EOF'
---
"simpleedit": patch
---

Description of the change.
EOF
```

Use `patch` for bug fixes, `minor` for new features, `major` for breaking changes.

## Packaging & releases
- **electron-builder** packages the app for macOS (dmg/zip), Windows (NSIS), and Linux (AppImage/deb)
- **Changesets** manages versioning and changelogs (`@changesets/cli`)
- Release flow:
  1. Add a changeset when making notable changes: `pnpm changeset`
  2. On merge to `main`, the `version.yml` workflow creates/updates a "Version Packages" PR
     that bumps the version in `package.json` and updates `CHANGELOG.md`
  3. Merging that PR triggers `changeset tag` → creates a `v*` git tag
  4. `version.yml` then **calls** `release.yml` → builds all platforms → creates the
     GitHub Release, which ends up published (no draft to approve, despite
     `draft: true` — verify with `gh release view <tag> --json isDraft`, and note
     that `publishedAt` is backdated to the tag commit and proves nothing)
  5. `version.yml` then **calls** `homebrew.yml` → renders the cask → pushes it to the tap

**Nothing in this chain is event-driven, and it must stay that way.** GitHub does
not let events created with `GITHUB_TOKEN` start new workflow runs, so neither the
pushed `v*` tag nor the created release triggers anything — confirmed by
`gh run list --json event`, which has never once shown a `release` event for this
repo. Each stage is therefore an explicit `uses:` call from `version.yml`. Wiring
a new stage to `on: release` or `on: push: tags:` will silently never run.
- Local packaging: `pnpm package` (all), or `pnpm package:mac` / `package:win` / `package:linux`
- macOS builds are ad-hoc signed only (`scripts/mac-adhoc-sign.cjs`), never notarized

### Homebrew distribution (macOS)
`brew install --cask pago/simpleedit/simpleedit` is the recommended macOS install.
The cask's source of truth is `scripts/homebrew/simpleedit.rb.template`;
`scripts/render-cask.mjs` fills in the version and both dmg digests, and
`homebrew.yml` pushes the rendered file to the **pago/homebrew-simpleedit** tap
(a separate repo — it holds generated output only, so never hand-edit it).

Three things about this are easy to get wrong:
- It is **called** by `version.yml`, not triggered by an event — see the release
  flow above. It also accepts `workflow_dispatch` with a `tag`, which is how you
  backfill the tap for a release that predates this wiring.
- Pushing cross-repo needs the `HOMEBREW_TAP_SSH_KEY` secret (a write-enabled
  deploy key on the tap); the built-in `GITHUB_TOKEN` cannot write to the tap.
- Homebrew 6 requires non-official taps to be trusted. The only exemption is
  naming the cask or tap in full in the command, which is why
  `BREW_UPGRADE_COMMAND` (`shared/ipc-types.ts`) is fully qualified — and why
  the README tells users to `brew trust pago/simpleedit` once.

Because notarization is what Squirrel's signature check wants, macOS copies
cannot self-update through electron-updater. `homebrew.ts` detects a Homebrew
install (a `Caskroom/simpleedit/<running version>` directory exists),
`auto-update.ts` turns off `autoDownload`, and the update is flagged
`managedByHomebrew` so `UpdateBanner` takes the brew path.

### Why the Homebrew upgrade runs detached
**Do not** make `update:install` run `brew upgrade` as a child process, and do
not add `uninstall quit:` to the cask. SimpleEdit is a terminal: `brew upgrade`
started from inside it is a descendant of the bundle being replaced, and
`before-quit` → `killAllTerminals` (`index.ts`) would kill brew mid-upgrade —
after Homebrew moved the old bundle to its backup and before the new one is in
place, leaving no app in /Applications.

So `startHomebrewUpgrade` writes `UPGRADE_SCRIPT` to userData and spawns it with
`detached: true` + `unref()`, giving it its own session. The helper waits for the
app's pid to exit, double-checks no instance was reopened (`pgrep -f` on the
bundle's executable path), runs the upgrade, and relaunches with `open`. It runs
brew with stdin from /dev/null so a sudo prompt fails fast instead of hanging
forever with no terminal to answer it.

Its brew timeout watchdog **polls** (`sleep 0.1` per tick) and the helper
`wait`s for it; do not go back to one long `sleep` killed via a trap. A signal
landing between that sleep's fork and `$!` being read orphans it for the full
half hour. That was rare, but it happened on loaded CI runners.
`homebrew-script.test.ts` runs the helper detached and proves nothing outlives
it by probing its process group the moment it exits.

The helper has no window to report to, so it writes a verdict JSON that
`takeUpgradeResult` picks up on the next launch and reports as
`update:homebrew-failed` — otherwise a failed background upgrade would be
entirely silent. `UPGRADE_SCRIPT` is exported and exercised against a stub `brew`
in `homebrew-script.test.ts`; a bug in it would otherwise only appear during a
real upgrade.

## What's deferred to v2
- AI narration ("Narrate this changeset" via Anthropic API)
- Windows/Linux package managers (winget, scoop, apt repo)
- Keyboard shortcuts for pane navigation
- Code signing and notarization (Homebrew covers the macOS install/update gap)
