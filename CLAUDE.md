# SimpleEdit — Claude Context

## Skills
- svelte-core-bestpractices

## Project overview
SimpleEdit is an opinionated, agentic-development IDE built with Electron + Svelte.
It targets developers using Claude Code across multiple git worktrees in parallel.

The core insight: when you run Claude Code across multiple worktrees, the developer's
job shifts from *writing* code to *reviewing* code and providing direction. The IDE is
built around that workflow — diff review, file highlighting, and Claude interaction
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

### Per-pane state (not global stores)
Each WorktreePane owns its open files, active file, and modified state locally.
This allows two panes side-by-side with completely independent editor state.
The global stores (`worktrees.svelte.ts`, `diffReview.svelte.ts`) are only for
state that genuinely crosses component boundaries (sidebar ↔ pane).

### IPC namespace convention
All IPC channels use a `namespace:action` pattern. Each namespace maps to a
main-process module:
- `app:` — window/repo lifecycle (`index.ts`, `recent-repos.ts`)
- `worktree:` — git worktree management (`worktree.ts`)
- `pty:` — terminal/PTY management (`pty.ts`)
- `fs:` — file system operations (`file-watcher.ts`)
- `editor:` — file read/write for the editor (uses `file-watcher.ts`)
- `git:` — git log, diff, commit inspection (`git-operations.ts`)
- `claude:` — Claude Code stream parser + PTY spawn (`claude-stream.ts`, `pty.ts`)

### Claude Code integration
The "✦ Claude" button in terminal tabs spawns `claude --output-format stream-json`
in a PTY and auto-attaches the stream parser. The parser reads PTY output line by
line, tries `JSON.parse`, and emits:
- `claude:status` — idle/running/waiting/error (shown in worktree sidebar)
- `claude:file-touch` — file paths from Write/Edit/Read tool uses (highlighted in file tree)

The "Ask Claude" bar in the diff review sends contextual questions (with commit/file
info) directly to the Claude terminal's PTY input.

### Diff review flow
GitLog sidebar → click commit → `diffReviewStore` → WorktreePane shows DiffReview.
DiffReview uses Monaco's `createDiffEditor` for inline diffs. "Uncommitted changes"
entry compares working tree against HEAD.

### Layout
```
┌─ Title bar (drag region, repo name) ─────────────────────┐
├─ Sidebar ─┬─ Pane (primary) ──────┬─ Pane (secondary)? ──┤
│ Worktrees  │ Editor / DiffReview   │ Editor / DiffReview   │
│ Git Log    │ ──── resize ────────  │ ──── resize ────────  │
│            │ File Tree (right)     │ File Tree (right)     │
│            │ ════ resize ════════  │ ════ resize ════════  │
│            │ Terminal Tabs         │ Terminal Tabs         │
└────────────┴──────────────────────┴───────────────────────┘
```
File tree is on the right (unusual but intentional — editor is the primary focus).
All splits are user-resizable.

## File structure

```
src/
  main/
    index.ts           ← App lifecycle, IPC registration, per-window routing
    pty.ts             ← node-pty manager (spawn, write, resize, kill)
    worktree.ts        ← simple-git worktree operations
    file-watcher.ts    ← chokidar + file I/O
    git-operations.ts  ← commit log, diff, file-at-commit, staging
    claude-stream.ts   ← stream-json parser, PTY data tap
    recent-repos.ts    ← Recently opened repos (persisted JSON)
  preload/
    index.ts           ← Typed contextBridge (invoke, on, once)
    index.d.ts         ← Global window.api type declaration
  renderer/
    App.svelte         ← Root: Welcome screen or IDE layout
    main.ts            ← Svelte mount + Monaco worker setup
    app.css            ← Tailwind import + drag-region CSS
    monaco-setup.ts    ← Monaco web worker registration
    components/
      Welcome.svelte          ← Repo picker + recent repos
      sidebar/
        Sidebar.svelte        ← WorktreeList + GitLog
        WorktreeList.svelte   ← Worktree listing with Claude status
        GitLog.svelte         ← Commit list + staging entry
      layout/
        PaneManager.svelte    ← 1 or 2 panes side-by-side
        WorktreePane.svelte   ← Self-contained pane (editor+tree+terminal)
        MainPanel.svelte      ← (legacy, superseded by PaneManager)
      editor/
        CodeEditor.svelte     ← Monaco editor wrapper
        EditorTabs.svelte     ← Open file tabs with modified indicator
        DiffReview.svelte     ← Commit/staging review with file list
        MonacoDiffEditor.svelte ← Monaco diff editor wrapper
        DiffViewer.svelte     ← (legacy, superseded by DiffReview)
      terminal/
        Terminal.svelte       ← xterm.js instance
        TerminalTabs.svelte   ← Tab bar with + and ✦ Claude buttons
      filetree/
        FileTree.svelte       ← Root tree + chokidar watcher
        FileNode.svelte       ← Recursive file/dir entry
    stores/
      worktrees.svelte.ts     ← Global worktree list + active worktree
      activeFile.svelte.ts    ← (legacy, used by MainPanel only)
      diffReview.svelte.ts    ← Per-worktree diff review target
      claude-status.svelte.ts ← Per-worktree Claude status + touched files
      diffViewer.svelte.ts    ← (legacy, unused)
  shared/
    ipc-types.ts       ← All IPC channel type definitions
    git-types.ts       ← Re-exports from ipc-types
```

## Packaging & releases
- **electron-builder** packages the app for macOS (dmg/zip), Windows (NSIS), and Linux (AppImage/deb)
- **Changesets** manages versioning and changelogs (`@changesets/cli`)
- Release flow:
  1. Add a changeset when making notable changes: `pnpm changeset`
  2. On merge to `main`, the `version.yml` workflow creates/updates a "Version Packages" PR
     that bumps the version in `package.json` and updates `CHANGELOG.md`
  3. Merging that PR triggers `changeset tag` → creates a `v*` git tag
  4. The tag triggers `release.yml` → builds all platforms → creates a draft GitHub Release
- Local packaging: `pnpm package` (all), or `pnpm package:mac` / `package:win` / `package:linux`
- Builds are currently unsigned (acceptable for alpha)

## What's deferred to v2
- AI narration ("Narrate this changeset" via Anthropic API)
- LSP / go-to-definition (text-search navigation is sufficient for v1)
- Distribution via Homebrew (GitHub Releases for v1)
- Keyboard shortcuts for pane navigation
- Code signing and notarization
