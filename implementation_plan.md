# SimpleEdit — Implementation Plan

## Git workflow

SimpleEdit uses a bare repo (`simpleedit.git/`) with worktrees alongside it.
Each major feature gets its own worktree branching from `main`.

```
simpleedit.git/          ← bare repo
plan/                    ← planning worktree (this branch)
app/                     ← main app worktree (branch: app-scaffold)
```

### Setup instructions for agents

Before any implementation work, create the `app` worktree from the bare repo:

```bash
cd /Users/patrick.gotthardt/Projects/open-source/simpleedit
git --git-dir=simpleedit.git worktree add app main
```

Then scaffold the Electron project inside `app/`. All implementation happens there.

When parallelizing work on independent features, create temporary worktrees:

```bash
# Example: two agents working in parallel
git --git-dir=simpleedit.git worktree add wt-terminal feature/terminal
git --git-dir=simpleedit.git worktree add wt-filetree feature/filetree
```

After merging, clean up:
```bash
git --git-dir=simpleedit.git worktree remove wt-terminal
```

---

## Implementation phases

### Phase 0: Scaffold (sequential — must complete first)

**Branch:** `main` (via `app/` worktree)

This phase establishes the skeleton that all other work builds on. It cannot be
parallelized because everything depends on it.

1. **Electron + Vite + Svelte scaffold**
   - `npm create electron-vite` (or manual setup)
   - Svelte 5, TypeScript strict, Tailwind 4
   - Verify dev mode hot-reload works

2. **Shared types foundation**
   - `src/shared/ipc-types.ts` — define IPC channel type map
   - `src/shared/git-types.ts` — worktree, commit, diff types

3. **Preload bridge**
   - `src/preload/index.ts` — typed `contextBridge` exposing IPC to renderer

4. **App shell layout**
   - `App.svelte` with resizable pane layout (sidebar | main area)
   - Empty placeholder components for each panel
   - Basic Tailwind theme (dark mode, monospace-friendly)

**Done when:** `npm run dev` opens an Electron window with a resizable sidebar
and empty content area. IPC types compile. Preload bridge is wired.

---

### Phase 1: Core features (parallelizable)

Once the scaffold is on `main`, these four tracks can run in parallel as
separate worktrees. Each creates a feature branch from `main`.

#### Track A: Worktree management
**Worktree:** `wt-worktrees` / **Branch:** `feature/worktrees`

- `src/main/worktree.ts` — `simple-git` wrapper: list, create, remove worktrees
- `WorktreeList.svelte` — sidebar component showing worktrees
- IPC channels: `worktree:list`, `worktree:create`, `worktree:remove`, `worktree:select`
- Selecting a worktree updates global state; other panels react

**Dependencies:** scaffold only
**Merge target:** `main`

#### Track B: Terminal + PTY
**Worktree:** `wt-terminal` / **Branch:** `feature/terminal`

- `src/main/pty.ts` — `node-pty` manager: spawn, write, resize, kill per terminal
- `Terminal.svelte` — xterm.js instance, connected to PTY via IPC
- `TerminalTabs.svelte` — tab bar for multiple terminals per worktree
- IPC channels: `pty:spawn`, `pty:data`, `pty:resize`, `pty:kill`
- Terminals persist when switching worktrees (hidden, not destroyed)

**Dependencies:** scaffold only
**Merge target:** `main`

#### Track C: File tree + watcher
**Worktree:** `wt-filetree` / **Branch:** `feature/filetree`

- `src/main/file-watcher.ts` — chokidar watching active worktree root
- `FileTree.svelte` / `FileNode.svelte` — recursive tree, lazy-loaded
- IPC channels: `fs:watch`, `fs:list`, `fs:read`
- Clicking a file emits `editor:open` (editor doesn't need to exist yet —
  just emit the event and log it)

**Dependencies:** scaffold only
**Merge target:** `main`

#### Track D: Monaco editor
**Worktree:** `wt-editor` / **Branch:** `feature/editor`

- `CodeEditor.svelte` — Monaco instance, loads file content via IPC
- IPC channels: `editor:open`, `editor:save`, `editor:content`
- Configure Monaco: dark theme, read file on open, save on Cmd+S
- Tab support: multiple open files with tab bar

**Dependencies:** scaffold only
**Merge target:** `main`

---

### Phase 2: Integration (sequential merges, then parallel tracks)

Merge all Phase 1 branches into `main`. Resolve conflicts (likely in
`ipc-types.ts` and `App.svelte`). Then two parallel tracks:

#### Track E: Stream-json + Claude Code integration
**Worktree:** `wt-claude` / **Branch:** `feature/claude-stream`

- `src/main/claude-stream.ts` — attach to PTY output, parse stream-json events
- Emit structured events: `claude:file-touch`, `claude:status`, `claude:tool-use`
- File tree highlights files Claude is touching (subscribe to `claude:file-touch`)
- Worktree sidebar shows status per worktree (subscribe to `claude:status`)

**Dependencies:** Track A (worktrees), Track B (terminal), Track C (file tree)
**Merge target:** `main`

#### Track F: Diff viewer + git log
**Worktree:** `wt-diff` / **Branch:** `feature/diff`

- `GitLog.svelte` — commit list in sidebar (per worktree)
- `DiffViewer.svelte` — render diffs (use `diff2html` or Monaco's built-in diff)
- IPC channels: `git:log`, `git:diff`, `git:show`
- Click commit → view diff in editor area

**Dependencies:** Track A (worktrees), Track D (editor area)
**Merge target:** `main`

---

### Phase 3: Multi-pane + polish (sequential)

**Branch:** `feature/multi-pane` from `main` (after Phase 2 merges)

- `PaneManager.svelte` — split view: two independent worktree contexts side by side
- Each pane has its own: worktree selection, terminal tabs, file tree, editor
- Keyboard navigation between panes
- Edge cases: worktree deleted while active, terminal crash recovery
- Package for direct download (electron-builder)

---

## Parallel execution map

```
Phase 0 (scaffold)
    │
    ├─── Track A: worktrees ──────┐
    ├─── Track B: terminal ───────┤
    ├─── Track C: file tree ──────┤  ← 4 agents in parallel
    ├─── Track D: editor ─────────┘
    │
    │ merge all into main
    │
    ├─── Track E: claude-stream ──┐
    ├─── Track F: diff viewer ────┘  ← 2 agents in parallel
    │
    │ merge into main
    │
    Phase 3 (multi-pane + polish)
```

## Agent instructions

When spawning sub-agents for parallel tracks:

1. **Each agent gets its own worktree** — use `isolation: "worktree"` or create
   the worktree manually via the bare repo
2. **Each agent must read `CLAUDE.md`** for conventions (Svelte 5 runes, no `any`, etc.)
3. **IPC types are the contract** — each track defines its IPC channels in
   `src/shared/ipc-types.ts`. On merge, these get combined. Agents should use
   a namespaced prefix (`worktree:`, `pty:`, `fs:`, `editor:`, `claude:`, `git:`)
   to avoid conflicts
4. **Don't build what you don't own** — if Track C needs to open a file in the
   editor, emit the IPC event and log it. Don't stub out the editor component.
5. **Write tests for main-process modules** — `worktree.ts`, `pty.ts`,
   `file-watcher.ts`, `claude-stream.ts` should have unit tests
