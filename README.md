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

## Installing

### macOS — Homebrew (recommended)

```bash
brew trust pago/simpleedit
brew install --cask pago/simpleedit/simpleedit
```

Then, to update:

```bash
brew upgrade --cask simpleedit
```

The cask clears the download quarantine flag for you, so there is no Gatekeeper
detour — SimpleEdit launches straight away.

Both lines matter. Homebrew 6 refuses to load casks from non-official taps
unless you either trust the tap or name it in full on the command line, so
without `brew trust` a plain `brew upgrade` **silently skips SimpleEdit** rather
than updating it. You only ever run it once.

### macOS — manual download

Grab the latest `.dmg` from the [Releases page](https://github.com/pago/simpleedit/releases).

SimpleEdit is ad-hoc signed but not notarized by Apple, so a downloaded copy
needs a one-time approval:

1. Open the `.dmg` and drag **SimpleEdit** to Applications.
2. Double-click SimpleEdit. macOS will refuse to open it the first time.
3. Go to **System Settings → Privacy & Security**, scroll to the note about SimpleEdit being blocked, and click **Open Anyway**.

Alternatively, clear the download quarantine flag from a terminal and launch normally:

```bash
xattr -dr com.apple.quarantine /Applications/SimpleEdit.app
```

> If you see **"SimpleEdit is damaged and can't be opened"** on an older build, it predates ad-hoc signing — download the latest release, or run the `xattr` command above.

Because Apple notarization is what Squirrel's signature check wants, a manually
installed copy can download an update but not install it. The in-app updater
therefore only offers a restart on Windows and Linux; on macOS, prefer Homebrew.

### Windows / Linux

Grab the `.exe` (Windows) or `.AppImage` / `.deb` (Linux) from the
[Releases page](https://github.com/pago/simpleedit/releases). These builds
self-update in place — the banner's **Restart & Update** button works.

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

## Language server support

SimpleEdit provides LSP-powered diagnostics, hover info, and go-to-definition for several languages. Each language server is resolved from your project's `node_modules/.bin` first, then your system PATH — so you can install them locally per project or globally.

### TypeScript / JavaScript

```bash
# local (recommended — picks up project's own TypeScript)
npm install --save-dev typescript typescript-language-server

# global
npm install -g typescript typescript-language-server
```

Both `typescript` and `typescript-language-server` are needed. SimpleEdit automatically passes the project's local `tsserver.js` path to the language server so it uses the same TypeScript version as your build.

### CSS / SCSS / Less

```bash
# local
npm install --save-dev vscode-langservers-extracted

# global
npm install -g vscode-langservers-extracted
```

### JSON

Included in `vscode-langservers-extracted` (see CSS above).

### Rust

Install `rust-analyzer` via rustup or your system package manager:

```bash
rustup component add rust-analyzer
# or: brew install rust-analyzer
```

### Python

```bash
pip install python-lsp-server
# or: pipx install python-lsp-server
```

### Go

```bash
go install golang.org/x/tools/gopls@latest
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
