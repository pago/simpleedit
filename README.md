# SimpleEdit

**An Agentic Development Environment for engineers who run Claude Code.**

SimpleEdit is built around a simple observation: when you run AI agents across multiple worktrees in parallel, your job changes. You're no longer writing code line by line — you're directing agents, reviewing their output, and deciding what ships. SimpleEdit is designed for exactly that workflow.

> **Alpha software.** Expect rough edges, missing features, and occasional bugs. We're building this in the open and welcome feedback.

---

## What makes it different

Most development tools are built around the act of writing code. SimpleEdit is built around the act of *reviewing* code that agents have written.

- **Diff-first UI** — commit review and staged change inspection are first-class, not buried in a menu
- **Multi-worktree by design** — run separate agents on separate branches simultaneously, with independent editor state per pane
- **Live agent awareness** — see which files Claude Code has touched, and what it's currently doing, without leaving your review flow
- **Contextual agent interaction** — send questions about a specific commit or diff directly to a Claude terminal, with context pre-filled
- **Embedded terminals** — spawn Claude Code sessions as named tabs, right alongside your editor

The file tree sits on the right. The editor is the primary focus. All splits are resizable.

---

## Built for Claude Code + worktrees

SimpleEdit works best with a bare git repository and git worktrees — one worktree per agent session. It will clone any repo into that structure automatically, or you can open an existing bare repo.

```
myproject.git/          ← bare repo
myproject-main/         ← main worktree
myproject-feature-a/    ← agent working here
myproject-feature-b/    ← another agent, another branch
```

Each pane in SimpleEdit tracks its own worktree independently. You can review a diff in one pane while an agent is still running in the other.

---

## Status

SimpleEdit is alpha quality software. It works well for the core workflow, but you will encounter:

- Missing keyboard shortcuts
- UI rough edges
- Occasional crashes or rendering glitches
- Features that are present but incomplete

We're using SimpleEdit to build SimpleEdit, which helps us find and fix the sharpest edges quickly.

---

## Getting started

```bash
pnpm install
node-pty must be rebuilt for Electron:
  pnpm exec electron-rebuild -f -w node-pty
pnpm dev
```

To package:

```bash
pnpm package        # all platforms
pnpm package:mac    # macOS only
```

---

## Tech stack

- **Electron** — desktop shell
- **Svelte 5** — UI with runes (`$state`, `$derived`, `$effect`)
- **Monaco Editor** — the same editor engine as VS Code
- **xterm.js + node-pty** — embedded terminals
- **simple-git** — all git operations
- **stream-json** — Claude Code output parsed in the main process

---

## Contributing

SimpleEdit is open source. Issues and pull requests welcome. If you're using Claude Code heavily and have thoughts on the workflow, we'd love to hear them.
