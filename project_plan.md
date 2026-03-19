# SimpleEdit — Project Plan

## Vision
A next-generation IDE built for *agentic development*: orchestrating Claude Code
across multiple git worktrees in parallel. The developer's job shifts from writing
code to providing direction, reviewing AI output and navigating codebases efficiently.

SimpleEdit is opinionated by design — it assumes a bare-repo + worktree workflow
and Claude Code as the agent. That constraint is its superpower.

---

## v1 scope (daily-drivable)

### 1. Worktree sidebar
- List worktrees from the bare repo
- Create / remove worktrees
- Switch active context (file tree + terminal follow the selection)
- **Status indicator per worktree**: idle / running / waiting for input / error
  (derived from stream-json events)

### 2. Embedded terminal (primary panel)
- Full PTY via `node-pty` rendered with `xterm.js`
- Claude Code runs inside it, exactly as in a normal terminal
- **Multiple terminal tabs per worktree** (e.g. Claude in one, build/test in another)
- Terminal instances persisted across context switches
- Generous scrollback buffer

### 3. File tree
- Watches active worktree with `chokidar`
- Click to open file in editor
- **Highlights files currently being touched by Claude Code** (via stream-json)
  — always on, not opt-in; this is the core differentiator

### 4. Code editor
- **Monaco Editor** (same engine as VS Code)
- Full editing support — fix typos, adjust configs, tweak prompts without leaving the app
- Syntax highlighting for common languages
- Go-to-definition deferred to v2 (simple text search / Ctrl+click → grep is fine for now)

### 5. Diff / changeset viewer
- Git log in sidebar; click commit to view diff
- Syntactic diffing (shell out to `difftastic` or use `diff2html`)

### 6. Multi-pane layout
- Two worktrees side by side — essential for parallel agentic work
- Each pane has its own terminal tabs, file tree, and editor context

---

## Deferred to v2

- **AI narration** ("Narrate this changeset" via Anthropic API) — Claude Code in the
  terminal already serves this purpose; build a dedicated feature once v1 is stable
- **LSP / go-to-definition** — text-search based navigation is sufficient for v1
- **Distribution** via Homebrew tap or npm global — GitHub Releases / direct download for v1

---

## Milestones

| Week | Goal |
|------|------|
| 1 | Electron scaffold, worktree sidebar with status, PTY terminal with tabs |
| 2 | File tree + Monaco editor, stream-json IPC plumbing, file-touch highlighting |
| 3 | Diff viewer, git log, multi-pane layout |
| 4 | Polish: keyboard nav, scrollback, edge cases, packaging for direct download |

---

## Tech stack

| Concern | Choice | Reason |
|---------|--------|--------|
| Shell | Electron | Filesystem, PTY, OS integration |
| Build | Vite + electron-vite | Fast HMR in renderer |
| UI | Svelte 5 | Runes make reactive state simple |
| Styling | Tailwind 4 | Utility-first, no class overhead |
| Terminal | xterm.js + node-pty | True PTY, same as VS Code |
| Code editor | Monaco Editor | Full VS Code editing engine; free multi-cursor, find/replace, keybindings |
| Git | simple-git | No shell-out, typed API |
| File watch | chokidar | Cross-platform, reliable |

---

## Resolved decisions
- **LSP in v1?** No — deferred to v2. Text search navigation is enough.
- **Multi-pane in v1?** Yes — parallel worktrees are the core workflow.
- **Stream-json opt-in?** No — always on. It's what makes SimpleEdit different.
- **Distribution for v1?** GitHub Releases / direct download. Homebrew later.
- **Code viewer vs editor?** Editor. Read-only means keeping a second editor open, defeating the purpose.
- **CodeMirror vs Monaco?** Monaco. Editing is a v1 requirement, and Monaco provides a complete editor for free in Electron (bundle size is irrelevant).

---

## File structure (target)

```
simpleedit.git/          ← bare repo
plan/                    ← this worktree (planning only)
  project_plan.md
  CLAUDE.md
app/                     ← main development worktree (to be created)
  CLAUDE.md              ← symlink or copy from plan/
  package.json
  electron.vite.config.ts
  src/
    main/                ← Electron main process
      index.ts
      worktree.ts        ← git/worktree management
      pty.ts             ← node-pty process manager
      claude-stream.ts   ← stream-json parser + IPC emitter
      file-watcher.ts    ← chokidar integration
    preload/
      index.ts           ← contextBridge API surface
    renderer/            ← Svelte app
      app.svelte
      components/
        sidebar/
          WorktreeList.svelte
          GitLog.svelte
        terminal/
          Terminal.svelte
          TerminalTabs.svelte
        filetree/
          FileTree.svelte
          FileNode.svelte
        editor/
          CodeEditor.svelte
          DiffViewer.svelte
        layout/
          PaneManager.svelte
      stores/            ← only truly global state
        worktrees.svelte.ts
        activeFile.svelte.ts
    shared/
      ipc-types.ts       ← all IPC channel types
      git-types.ts
```
