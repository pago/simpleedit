# SimpleEdit — Project Plan

## Vision
A next-generation IDE built for *agentic development*: orchestrating Claude Code
across multiple git worktrees in parallel. The developer's job shifts from writing
code to providing direction, reviewing AI output and navigating codebases efficiently.

SimpleEdit is opinionated by design — it assumes a bare-repo + worktree workflow
and Claude Code as the agent. That constraint is its superpower.

---

## MVP scope (dog-foodable v0)

### 1. Worktree sidebar
- List worktrees from the bare repo
- Create / remove worktrees
- Switch active context (file tree + terminal follow the selection)

### 2. Embedded terminal
- Full PTY via `node-pty` rendered with `xterm.js`
- Claude Code runs inside it, exactly as in a normal terminal
- One terminal instance per worktree, persisted across context switches

### 3. File tree
- Watches active worktree with `chokidar`
- Click to open file in viewer
- Highlights files currently being touched by Claude Code (via stream-json)

### 4. Code viewer
- CodeMirror 6, read-focused (no editing in v0)
- Syntax highlighting for common languages
- Click-to-navigate: go-to-definition overlay (LSP optional in v1)

### 5. Diff / changeset viewer
- Git log in sidebar; click commit to view diff
- Syntactic diffing (shell out to `difftastic` or use `diff2html`)
- "Narrate this changeset" button — calls Anthropic API, streams explanation

---

## Milestones

| Week | Goal |
|------|------|
| 1 | Electron scaffold, worktree sidebar, PTY terminal working |
| 2 | File tree + CodeMirror viewer, stream-json IPC plumbing |
| 3 | Diff viewer, git log, AI narration |
| 4 | Polish: keyboard nav, multi-pane, commit annotations |

---

## Tech stack

| Concern | Choice | Reason |
|---------|--------|--------|
| Shell | Electron | Filesystem, PTY, OS integration |
| Build | Vite + electron-vite | Fast HMR in renderer |
| UI | Svelte 5 | Runes make reactive state simple |
| Styling | Tailwind 4 | Utility-first, no class overhead |
| Terminal | xterm.js + node-pty | True PTY, same as VS Code |
| File viewer | CodeMirror 6 | Lightweight, composable |
| Git | simple-git | No shell-out, typed API |
| File watch | chokidar | Cross-platform, reliable |
| AI narration | @anthropic-ai/sdk | Stream changeset explanations |

---

## Open questions
- [ ] Do we embed a language server (LSP) for go-to-definition in v1 or v2?
- [ ] Multi-pane layout (two worktrees side by side) — v1 or v2?
- [ ] Should the stream-json Claude Code integration be opt-in (fallback to raw PTY)?
- [ ] Distribution strategy: homebrew tap, direct download, or npm global?

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
        filetree/
          FileTree.svelte
          FileNode.svelte
        viewer/
          CodeViewer.svelte
          DiffViewer.svelte
          NarrationPanel.svelte
      stores/            ← only truly global state
        worktrees.svelte.ts
        activeFile.svelte.ts
    shared/
      ipc-types.ts       ← all IPC channel types
      git-types.ts
```
