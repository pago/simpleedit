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
- `claude:status` — idle/running/waiting/error (shown per session in the sidebar)
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
`PostToolUse` + `Stop` HTTP hooks to the per-window bridge's `/<token>/hooks`
endpoint. (`Stop` serves agent messaging — see below.)
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

**No new transport.** The bridge already had both directions and they were simply
never connected: an agent SENDS via `/tool-call`, and RECEIVES through the
**response body of its own `Stop` hook**. When a session's turn ends with mail
queued, `handleHook` answers `{decision:'block', reason:<mail>}` — which both
Claude Code and Codex honour by continuing the turn with that text as input.

Consequences worth knowing before touching this:
- **Delivery is at turn boundaries only**, deliberately. Nothing writes to the
  PTY, so nothing races the live TUI.
- **`stop_hook_active` must gate delivery.** That flag means the stop already
  belongs to a turn a hook continued; blocking again re-blocks the same turn and
  the agent never reaches idle (Claude hard-caps this at 8 blocks, then overrides).
- **The reply channel is `last_assistant_message`** on the following `Stop`, so a
  peer answers *without calling any tool*. That is what removes the copy-paste.
  Only messages sent with `wait_for_reply` capture one — otherwise an unrelated
  "fyi" would relay the peer's next turn as a bogus answer.
- **The renderer owns the peer list** (labels, provider, status), so it pushes
  snapshots via `agent-bus:sync`; main cannot derive them.
- Exchanges are bounded: hop budget, per-sender rate limit, message size cap.
  `agent-message:sent` / `:delivered` are emitted for UI surfacing.

### Diff review flow
GitLog (in the session workspace) → click commit → `openDiffTab`
(`diffReview.svelte.ts`) → the session's `SessionWorkspace` opens a **diff tab**
rendering `DiffReview`. DiffReview uses Monaco's `createDiffEditor` for inline
diffs. "Uncommitted changes" entry compares working tree against HEAD.

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
    claude-paths.ts    ← Claude project/JSONL path helpers
    cwd-tracker.ts     ← Parses hook bodies → session cwd / repo-touch trail
    agent-bus.ts       ← Agent-to-agent messaging: peers, mailboxes, replies
    mcp-bridge.ts      ← Per-window HTTP bridge: MCP tool-calls + hook endpoint
    mcp-server/
      index.mjs        ← Stdio MCP server ("simpleedit" tools) → posts to bridge
    worktree.ts        ← simple-git worktree operations
    worktree-watcher.ts ← Watches for worktree add/remove
    file-watcher.ts    ← chokidar + file I/O
    editor-watcher.ts  ← Per-editor file change watching
    git-operations.ts  ← commit log, diff, file-at-commit, staging
    github/gh.ts       ← gh CLI wrapper (screen-PRs)
    screenprs.ts, screenprs-cache.ts ← Screen-PRs data + cache
    review.ts, deep-review.ts, tour.ts ← Review/tour features
    tasks/, agent-tasks/ ← Bounded agent-task orchestration (gate, runner)
    models/            ← Model catalog (Claude cloud + Ollama) + recommendations
    lsp-manager.ts     ← Language-server management
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
      screenprs/              ← ScreenPrsView, PrDetail, ReviewComposer, …
      settings/               ← SettingsWindow, ModelsPane, DefaultModelPane, …
      command-palette/        ← CommandPalette + input/results
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
    lib/                      ← sessionPersistence, session-brief, agent-message, branchName, …
  shared/
    ipc-types.ts       ← All IPC channel type definitions
    git-types.ts       ← Re-exports from ipc-types
    gen-ui-catalog.ts, screenprs.ts ← Shared gen-UI + screen-PRs types
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
