# simpleedit

## 0.7.4

### Patch Changes

- [#33](https://github.com/pago/simpleedit/pull/33) [`c8f22df`](https://github.com/pago/simpleedit/commit/c8f22df1e2d0c76c225d7ee209d9c8046cce2095) Thanks [@pago](https://github.com/pago)! - Fix MonacoDiffEditor recreating the entire Monaco instance on every file switch or content refresh. The creation effect now uses `untrack` for content and filePath reads, so it only re-runs when the container mounts. The existing content-update effect handles all subsequent changes cheaply.

- [#32](https://github.com/pago/simpleedit/pull/32) [`c585418`](https://github.com/pago/simpleedit/commit/c58541899f5c0ecd4d4c21714a7331032f558f57) Thanks [@pago](https://github.com/pago)! - Fix missing node_modules in production builds by bundling pure-JS dependencies into the main process bundle instead of externalizing them. Only node-pty (native module) remains external.

- [#33](https://github.com/pago/simpleedit/pull/33) [`9c0703b`](https://github.com/pago/simpleedit/commit/9c0703b312c6cd0bfd3937d3fd076e50a46b7b82) Thanks [@pago](https://github.com/pago)! - Fix renamed files showing a broken path in the diff review file list. Git outputs `R100\told\tnew` for renames, but the parser joined both paths with a tab. Now correctly uses the new (destination) path.

- [#33](https://github.com/pago/simpleedit/pull/33) [`b332e9e`](https://github.com/pago/simpleedit/commit/b332e9e84c278e2619eaff98f9b366bb770ddc3d) Thanks [@pago](https://github.com/pago)! - Fix staging entry in Git Log never showing as selected. The `?? undefined` fallback coerced `null` (staging hash) to `undefined`, so the "Uncommitted changes" row never got the highlighted style or correct `aria-selected` attribute.

## 0.7.3

### Patch Changes

- [#31](https://github.com/pago/simpleedit/pull/31) [`71b5c14`](https://github.com/pago/simpleedit/commit/71b5c141eaebd136e0f8d8138a6275f6b9147b5d) Thanks [@pago](https://github.com/pago)! - Auto-close terminal tabs when their PTY exits (e.g. after `/exit` in Claude), so the surviving tab becomes active automatically instead of showing a dead terminal.

- [#31](https://github.com/pago/simpleedit/pull/31) [`7ba4a80`](https://github.com/pago/simpleedit/commit/7ba4a806c02a49ea7fd7f4fea6e3d425c06480a8) Thanks [@pago](https://github.com/pago)! - Auto-select newly created or checked-out worktrees so the pane switches immediately without requiring a manual click.

- [#31](https://github.com/pago/simpleedit/pull/31) [`3363e1f`](https://github.com/pago/simpleedit/commit/3363e1f7305a5913624150551d258734db15bec2) Thanks [@pago](https://github.com/pago)! - Show a dimmed `origin/` prefix on remote-only branches in the checkout list so users can distinguish them from local branches.

- [#30](https://github.com/pago/simpleedit/pull/30) [`f901490`](https://github.com/pago/simpleedit/commit/f901490f326c779dfbfa5066dd29244895c809a8) Thanks [@pago](https://github.com/pago)! - Fix AI Review and AI Tour failing to find `claude` in packaged builds.

  Both features spawned `claude` by bare name, which fails when the app is packaged because the system `PATH` does not include shell-configured directories (nvm, Homebrew, etc.). They now resolve the full path to `claude` via an interactive login shell (`which claude`) — the same approach used for the Claude terminal — before spawning the subprocess.

- [#28](https://github.com/pago/simpleedit/pull/28) [`c30a302`](https://github.com/pago/simpleedit/commit/c30a30299604fadaf644f1596a34eacf3dc7a40d) Thanks [@pago](https://github.com/pago)! - fix: source ~/.zshrc in Claude terminal so claude is found on PATH

  The previous fix used a login shell (-l) which sources ~/.zprofile but not ~/.zshrc. Tools installed via nvm, npm global installs, or other ~/.zshrc-based PATH modifications were not available. Adding -i (interactive) ensures both files are sourced.

- [#31](https://github.com/pago/simpleedit/pull/31) [`a4f7d63`](https://github.com/pago/simpleedit/commit/a4f7d639f4f215345abf24a4db8e7da297380b26) Thanks [@pago](https://github.com/pago)! - Spawn regular terminal tabs as login shells so tools like pnpm are on PATH in production builds.

- [#31](https://github.com/pago/simpleedit/pull/31) [`44a67b3`](https://github.com/pago/simpleedit/commit/44a67b34f60a405b9238b609e5eebb0a117c5ff9) Thanks [@pago](https://github.com/pago)! - Focus the branch-name input automatically when clicking "+ New" in the worktree list.

## 0.7.2

### Patch Changes

- [#26](https://github.com/pago/simpleedit/pull/26) [`902b7be`](https://github.com/pago/simpleedit/commit/902b7bea6c63cb728e2b8023328a8a1079216bc4) Thanks [@pago](https://github.com/pago)! - Fix production build packaging and terminal issues

  - Add `.DS_Store` to `.gitignore`
  - Add `shamefully-hoist=true` to `.npmrc` so electron-builder can resolve transitive pnpm dependencies (fixes "Cannot find module 'ms'" on startup)
  - Spawn Claude terminal with a login shell (`zsh -l -c`) so `claude` is found on PATH when the app is launched via macOS GUI rather than a terminal

## 0.7.1

### Patch Changes

- [#24](https://github.com/pago/simpleedit/pull/24) [`78d712c`](https://github.com/pago/simpleedit/commit/78d712c11d27acdf14045c5fff7586903c923334) Thanks [@pago](https://github.com/pago)! - Fix missing native modules in packaged builds — remove the blanket node_modules exclusion from electron-builder so all production dependencies (simple-git, chokidar, vscode-jsonrpc, node-pty) are correctly bundled

## 0.7.0

### Minor Changes

- [#20](https://github.com/pago/simpleedit/pull/20) [`dba6538`](https://github.com/pago/simpleedit/commit/dba6538fed14cb163273281c1a1f46c59150de73) Thanks [@pago](https://github.com/pago)! - Add ability to check out an existing branch as a new worktree from the sidebar

### Patch Changes

- [#23](https://github.com/pago/simpleedit/pull/23) [`6e61002`](https://github.com/pago/simpleedit/commit/6e61002f05d1ef4cd55fa8ac38b68ac458e5ae41) Thanks [@pago](https://github.com/pago)! - Add custom app icon (four-pointed star on dark violet background) for macOS, Windows, and Linux builds.

- [#19](https://github.com/pago/simpleedit/pull/19) [`7859314`](https://github.com/pago/simpleedit/commit/7859314e8baac607ca46968c2c3df092047ecce6) Thanks [@pago](https://github.com/pago)! - Fix node-pty not found in packaged builds by including it in electron-builder files list

## 0.6.0

### Minor Changes

- [#18](https://github.com/pago/simpleedit/pull/18) [`015b7d8`](https://github.com/pago/simpleedit/commit/015b7d8d10eaa0757c1be85084e57b55ecf6c7d6) Thanks [@pago](https://github.com/pago)! - Add Language Server Protocol (LSP) integration for the Monaco editor

  Connects Monaco to language servers (TypeScript, JavaScript, and others) via an
  IPC-based JSON-RPC proxy. The main process resolves and spawns language servers
  from the project's own `node_modules/.bin` first, falling back to PATH.

  Features include go-to-definition, find all references, hover documentation,
  completions, signature help, document highlights, and inline diagnostics.
  Cross-file navigation works via Monaco's peek/reference overlay, which
  auto-loads file content for files not yet open in the editor.

  For TypeScript projects, the server uses the project's own `tsserver.js` so
  type resolution matches the installed TypeScript version exactly.

- [#16](https://github.com/pago/simpleedit/pull/16) [`de3eeec`](https://github.com/pago/simpleedit/commit/de3eeecfb1a794b33a1d4c58702c641509bdce0a) Thanks [@pago](https://github.com/pago)! - Add AI-powered changeset tour with commit and branch modes

  Introduces a "Tour" tab in the diff review that generates an AI-narrated
  walkthrough of a changeset, grouped by logical topic. Each topic includes
  prose explaining what changed and why, with lazy-mounted compact inline diff
  editors for relevant code hunks.

  **Commit tour:** Click "✦ Tour" on any commit or staged changes to get a
  guided walkthrough. Topics stream in progressively and are persisted to disk.

  **Branch tour:** Click "✦ Tour Branch" in the Git Log header to tour all
  changes on the current branch compared to main. The overview is editable
  and can be copied as a PR description.

  For staging tours, the overview is editable and can be used as a commit
  message. Editing the overview and clicking "Re-generate" feeds the correction
  back to Claude for a more accurate tour.

## 0.5.0

### Minor Changes

- [#15](https://github.com/pago/simpleedit/pull/15) [`9080561`](https://github.com/pago/simpleedit/commit/90805618d0e703a03743bf2512c86e31f719105d) Thanks [@pago](https://github.com/pago)! - Add AI-powered diff review with streaming findings

  Introduces a "✦ Review" button in the diff view that spawns Claude to analyze
  the current diff and stream back structured findings using Conventional Comments
  labels (praise, nitpick, suggestion, issue, question, thought, chore).

  Findings appear progressively as Claude streams them, are sorted by severity,
  and can be navigated to in the diff editor with line highlighting. Bulk operations
  allow dismissing multiple findings or forwarding them to an agent terminal with
  a custom instruction.

  Works for both commit diffs and uncommitted (staged) changes.

## 0.4.0

### Minor Changes

- [#9](https://github.com/pago/simpleedit/pull/9) [`31b721f`](https://github.com/pago/simpleedit/commit/31b721f821f49134e6b60292452201699cf14ea4) Thanks [@pago](https://github.com/pago)! - Add "Discuss with Agent" context menu action to both the code editor and diff viewer.

  Right-click any line or selection and choose "Discuss with Agent" (or press Cmd+I / Ctrl+I) to open a floating overlay with a text field. The overlay includes the file path, line range, and selected code as context. A dropdown lets you choose which running Claude agent to send to, or spawn a fresh one. The old Ask Claude bar in the diff viewer has been removed in favour of this richer, unified interaction.

### Patch Changes

- [#13](https://github.com/pago/simpleedit/pull/13) [`050c138`](https://github.com/pago/simpleedit/commit/050c138483769bd3b2f0859a8c2ce6d0d5c3d3ab) Thanks [@pago](https://github.com/pago)! - Fix worktree creation cancel on button click and add resizable file list in diff viewer

## 0.3.0

### Minor Changes

- [#7](https://github.com/pago/simpleedit/pull/7) [`b1479ac`](https://github.com/pago/simpleedit/commit/b1479ac170098b422af45570880cbc53cbf2c7fd) Thanks [@pago](https://github.com/pago)! - Claude status indicator in the worktree sidebar now correctly shows `running` while Claude is working and `idle` when it finishes. Claude terminal tabs also update their label to reflect the current session name.

- [#7](https://github.com/pago/simpleedit/pull/7) [`b1479ac`](https://github.com/pago/simpleedit/commit/b1479ac170098b422af45570880cbc53cbf2c7fd) Thanks [@pago](https://github.com/pago)! - Diff view now live-refreshes when git status changes, preserving the scroll position.

### Patch Changes

- [`52d85b8`](https://github.com/pago/simpleedit/commit/52d85b822789eae9be3faa7c1a073dc3df3183c9) Thanks [@pago](https://github.com/pago)! - Fix UI lag caused by polling-based file watcher by replacing chokidar worktree watching with lightweight git status polling and native FSEvents on git internals

- [#7](https://github.com/pago/simpleedit/pull/7) [`b1479ac`](https://github.com/pago/simpleedit/commit/b1479ac170098b422af45570880cbc53cbf2c7fd) Thanks [@pago](https://github.com/pago)! - Fix dragging a terminal tab to the last position — a drop zone is now shown after the final tab.

## 0.2.0

### Minor Changes

- [`de73e7e`](https://github.com/pago/simpleedit/commit/de73e7e44e0b6a0384a69d7b8db323c9b04b7fe3) Thanks [@pago](https://github.com/pago)! - Initial release of SimpleEdit — an opinionated, agentic-development IDE built for developers using Claude Code across multiple git worktrees.

  - Multi-window, per-repo workspace with side-by-side worktree panes
  - Integrated terminal with Claude Code support (stream-json parsing, status indicators, file touch highlighting)
  - Monaco-powered code editor with diff review for commits and uncommitted changes
  - File tree with chokidar-based live updates
  - Git log sidebar with commit inspection
  - Drag-and-drop tab reordering for editor and terminal tabs
  - Shift+Enter newline support in Claude terminals via kitty keyboard protocol
