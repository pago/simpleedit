# simpleedit

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
