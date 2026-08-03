# simpleedit

## 0.18.1

### Patch Changes

- [#157](https://github.com/pago/simpleedit/pull/157) [`1ab43be`](https://github.com/pago/simpleedit/commit/1ab43beac08546a5da79ef59211effbb8df18bd3) Thanks [@pago](https://github.com/pago)! - Ad-hoc sign the macOS build so it no longer reports "SimpleEdit is damaged and can't be opened" after download. An `afterPack` hook (`scripts/mac-adhoc-sign.cjs`) signs the fully-assembled bundle — including the node-pty and mcp-server payloads — with an ad-hoc signature, and electron-builder's own signing is disabled so that signature is authoritative. Builds remain unsigned by Developer ID, so first launch still requires bypassing Gatekeeper once (System Settings → Privacy & Security → "Open Anyway", or `xattr -dr com.apple.quarantine /Applications/SimpleEdit.app`).

## 0.18.0

### Minor Changes

- [#146](https://github.com/pago/simpleedit/pull/146) [`4aeac5c`](https://github.com/pago/simpleedit/commit/4aeac5c7fc334ae0359cfb87d562e80db0d0c607) Thanks [@pago](https://github.com/pago)! - Dependency maintenance sweep.

  - Upgraded Electron 35 → 42, picking up several HIGH-severity Chromium/Electron
    security fixes (use-after-free in offscreen paint, permission callbacks, and
    PowerMonitor). Bundled Node goes 22 → 24; node-pty is rebuilt for the new ABI.
  - Upgraded the build toolchain to Vite 7 (electron-vite 5, vite-plugin-svelte 6).
  - Upgraded TypeScript 6, xterm 6, chokidar 5, vscode-jsonrpc 9, monaco-editor
    0.55, and @json-render/svelte 0.19.
  - Refreshed all in-range dependencies, including security fixes for simple-git
    (RCE), vitest (dev-only), and dompurify; removed the unused @anthropic-ai/sdk.

- [#148](https://github.com/pago/simpleedit/pull/148) [`6e85bfa`](https://github.com/pago/simpleedit/commit/6e85bfa48a724f5320917970fe48f43737e947a7) Thanks [@pago](https://github.com/pago)! - Local & alternate model support. A new Settings window lets you discover, install (with hardware-aware recommendations), and pick Ollama or Claude models, and set per-feature default models for Review and Tour. Under the hood the hardwired Claude integration is generalized into an `AgentProvider` abstraction, and Review and Tour now run on a shared bounded-task substrate that can target a chosen model — cloud via Claude Code, or a local model via Ollama's native API. Interactive local sessions via Claude Code are intentionally disabled pending an upstream Ollama fix ([#13949](https://github.com/pago/simpleedit/issues/13949)); local models power the Review/Tour tasks instead.

- [#150](https://github.com/pago/simpleedit/pull/150) [`c3af3f9`](https://github.com/pago/simpleedit/commit/c3af3f9bce14612b7161afa3d0971467fa74d8d6) Thanks [@pago](https://github.com/pago)! - Add `runFanout` to the bounded-task orchestrator: run a task over N inputs with
  capped concurrency, streaming per-input lifecycle events (`start`/`item`/`done`/
  `error`) as they land. This is the fan-out substrate the upcoming Screen PRs
  feature is built on; a single input's failure is isolated to its own `error`
  event and never rejects the whole stream. Also lands the Screen PRs design docs.

- [#153](https://github.com/pago/simpleedit/pull/153) [`5bda32a`](https://github.com/pago/simpleedit/commit/5bda32a2e3148f081657b3f49740e0f2806d9551) Thanks [@pago](https://github.com/pago)! - Screen PRs — deep-review engine. A chosen PR can now run a thorough, multi-lens
  review: focused lenses (soundness, intent-vs-impl, test coverage, and optional
  type/architecture) run in parallel, then a synthesis pass dedups/ranks/drops
  noise. Mostly local by default (each lens inherits the triage model unless
  escalated to cloud in Settings); soundness/intent/tests on by default,
  type/architecture opt-in. Concurrency is gated per backend (local-serial for the
  GPU, cloud-parallel). The PR detail gains a Deep review action with live lens
  progress and a curated, severity-ranked findings list; triage collapses once
  deep review supersedes it. Findings are diff-only for now (repo-aware pass on a
  checked-out worktree follows with Discuss/handoff).

- [#155](https://github.com/pago/simpleedit/pull/155) [`8baad0b`](https://github.com/pago/simpleedit/commit/8baad0bc90538600b40029584619bab2e8bd472f) Thanks [@pago](https://github.com/pago)! - Screen PRs: review composer — the in-app path to post a GitHub review. Collect line comments from triage/deep findings (＋ review) or write your own, add a summary, pick a verdict (Approve / Comment / Request changes), and post via a confirm dialog. Adds a quick-approve ✓ on queue cards and stacks related PRs (base→head) so you review them in order. First write surface: line comments anchor to the diff where possible and fold into the summary otherwise; the post is guarded by a confirmation.

- [#151](https://github.com/pago/simpleedit/pull/151) [`acb6084`](https://github.com/pago/simpleedit/commit/acb6084f5e68e86215488df872182c455c067edd) Thanks [@pago](https://github.com/pago)! - Screen PRs — triage logic layer (main process). Adds the GitHub read adapter
  (`gh` search / view / diff / checks), the diff-only per-PR triage task (cheap
  local model via DirectRunner), deterministic bucketing (shared, so the renderer
  re-sorts as cards stream), and the fan-out orchestration + `screenprs:*` IPC that
  gathers the review queue, judges each PR, and streams bucketed cards. The
  split-view panel UI follows.

- [#152](https://github.com/pago/simpleedit/pull/152) [`a82af81`](https://github.com/pago/simpleedit/commit/a82af815bb5665736a34f69f22f5123edb80dbf9) Thanks [@pago](https://github.com/pago)! - Screen PRs — the triage view. Adds a "Screen PRs" entry pinned at the bottom of
  the sidebar (with an attention badge) that takes over the main area with a
  split-view: a streaming, bucketed queue (Needs attention / Quick pass / Waiting
  on author / Approved-FYI) that fills as each PR is triaged, and a PR detail pane
  showing the triage findings + a read-only diff. Deep review, Discuss, and the
  GitHub review composer follow.

### Patch Changes

- [#149](https://github.com/pago/simpleedit/pull/149) [`6f51166`](https://github.com/pago/simpleedit/commit/6f51166fd9aeb8b89f761b3220b185d32c3073f6) Thanks [@pago](https://github.com/pago)! - Enable interactive local (Ollama) coding sessions. Claude Code's `count_tokens` probe was hanging Ollama's Anthropic-compatible endpoint (Ollama [#13949](https://github.com/pago/simpleedit/issues/13949)); setting `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` on the local spawn sidesteps it, so tool-capable local models are now startable interactively from the model picker (on by default).

## 0.17.1

### Patch Changes

- [#144](https://github.com/pago/simpleedit/pull/144) [`7eee0df`](https://github.com/pago/simpleedit/commit/7eee0df30321dbb39cef91845d56017709b9f075) Thanks [@pago](https://github.com/pago)! - Fix: a repo the agent only **reads or edits a file in** (without `cd`-ing there) now appears in the session's repo picker. Repo tracking previously keyed solely off the hook `cwd`, which a Read/Edit/Write never moves, so sibling repos stayed invisible. `PostToolUse` now also resolves the touched `file_path` to its repo and records it on the trail — without repointing the workspace view.

## 0.17.0

### Minor Changes

- [#142](https://github.com/pago/simpleedit/pull/142) [`1c9fd4a`](https://github.com/pago/simpleedit/commit/1c9fd4a7d04e0e62ca9565ebee8bc5144551aa0f) Thanks [@pago](https://github.com/pago)! - Sessions panel: drag to reorder sessions, gather them into named, collapsible groups (Edge-style — drag and dwell over a session's center to group, or use the context menu), and create a new Claude session from the keyboard with ⌘T (focusing its terminal). Group membership and order persist across restarts.

## 0.16.0

### Minor Changes

- [#130](https://github.com/pago/simpleedit/pull/130) [`c179e19`](https://github.com/pago/simpleedit/commit/c179e19fe38f2f1a7e4c16dd97f7887ebdf8bbd4) Thanks [@pago](https://github.com/pago)! - Sessions now track the agent's location trail across repos and worktrees. When
  an agent works in a repo the window never opened, the hook handler resolves and
  registers it so it surfaces automatically. The repo picker becomes a dropdown
  over the repos this agent has worked in (switching one lands on its
  most-recently-touched worktree), and the worktree picker pins touched worktrees
  to the top — most-recent first — above a separator, then the rest
  alphabetically. The view only follows the agent while the Files viewer is
  closed; with it open, an amber indicator marks where the agent moved instead of
  swapping out what you're reviewing. The trail persists with resumable sessions.

- [#50](https://github.com/pago/simpleedit/pull/50) [`265df3b`](https://github.com/pago/simpleedit/commit/265df3bc3afe4c13da76f9d6f4d655e6a6b2bf65) Thanks [@pago](https://github.com/pago)! - Add automatic update support via electron-updater. The app now checks for new GitHub releases on startup and shows a banner when an update is available to download and install.

- [#135](https://github.com/pago/simpleedit/pull/135) [`5e1579e`](https://github.com/pago/simpleedit/commit/5e1579e039be87821141c290994ea751b6cbd2be) Thanks [@pago](https://github.com/pago)! - Make the Git Log panel collapsible. A chevron in its title bar collapses the panel to just the title bar (Tour Branch and Refresh buttons stay available) and expands it back to half of the files/git-log column. The collapsed state is persisted across sessions.

- [#140](https://github.com/pago/simpleedit/pull/140) [`0cdcf61`](https://github.com/pago/simpleedit/commit/0cdcf618a48ddae45fab7fa7b9f399eb8fb42b8c) Thanks [@pago](https://github.com/pago)! - Diff file list now uses filename-first labels so the filename stays visible
  without resizing the panel. Context-less names (`index.ts`, `mod.rs`,
  `__init__.py`, Next.js `page`/`route`/`layout`, …) are shown with their parent
  directory (e.g. `DiffReview/index.tsx`), and files that would otherwise share a
  label are disambiguated with the minimal distinguishing path segments. A
  styled, no-delay hover tooltip replaces the native `title` and reveals the full
  path.

- [#132](https://github.com/pago/simpleedit/pull/132) [`2588afd`](https://github.com/pago/simpleedit/commit/2588afd1314c7d42210b9ee2c2f0f5d4bbc30763) Thanks [@pago](https://github.com/pago)! - Remove Plan Mode. The structured plan view (NDJSON task list with reactions,
  status cycling, and per-task agent dispatch) forced plans into a data model
  that couldn't represent the prose, diagrams, and narrative that make a plan
  useful, and the resulting UI was cluttered. Planning is better served by a
  markdown document plus the existing terminal, so the feature has been dropped:
  the `show_plan` MCP tool, the headless plan generator, the `plan:*` IPC
  channels, the `plan` tab kind, and the Git Log "✦ Plan" button are all gone.

  Sessions saved by older builds that contain a plan tab restore cleanly — the
  stale tab is skipped on hydrate.

- [#137](https://github.com/pago/simpleedit/pull/137) [`509b43a`](https://github.com/pago/simpleedit/commit/509b43ad5e7b39f7ff309165eb371133100a9560) Thanks [@pago](https://github.com/pago)! - Watch open editor files for external changes. Clean buffers auto-reload from disk; dirty buffers show a "file changed on disk — reload?" banner so unsaved edits are never clobbered.

- [#133](https://github.com/pago/simpleedit/pull/133) [`c8ffc03`](https://github.com/pago/simpleedit/commit/c8ffc035fea6a0ef7db88f7f7548047543e7ee1f) Thanks [@pago](https://github.com/pago)! - Markdown files now open with raw / hybrid / rendered view modes, toggled from a control on the right of the tab bar (WebStorm-style). The rendered preview parses Markdown with `marked` + DOMPurify, renders mermaid diagrams and Monaco-themed syntax highlighting in fenced code blocks, resolves relative images via a worktree-scoped `wt-asset:` protocol, and keeps scroll position anchored between editor and preview in hybrid mode.

### Patch Changes

- [#138](https://github.com/pago/simpleedit/pull/138) [`41cb138`](https://github.com/pago/simpleedit/commit/41cb138d5fecd33228fe81c0326c8a8b5e4566d2) Thanks [@pago](https://github.com/pago)! - Fix inconsistent file-tree icon alignment. The folder/file emoji previously sat in a width-less span, so the icon and label columns drifted with each glyph's rendered width. Pinning the icon into a fixed-width centered slot keeps every row's icon and label aligned regardless of font/glyph rendering.

- [#136](https://github.com/pago/simpleedit/pull/136) [`509cacb`](https://github.com/pago/simpleedit/commit/509cacb34adfcd24c5dc5d97f76fb6e0c3ac9228) Thanks [@pago](https://github.com/pago)! - Fix Markdown view mode locking after the first switch. The per-file view-mode store used a plain `$state(new Map())`, whose `.set()`/`.get()` mutations are not tracked by Svelte 5; once a file had a stored mode the reader's dependency dropped and the toggle stopped responding. The store now uses `SvelteMap` so subsequent switches stay reactive.

- [#139](https://github.com/pago/simpleedit/pull/139) [`126cffb`](https://github.com/pago/simpleedit/commit/126cffbb8cba1823807af383b30792e53b5f2cfd) Thanks [@pago](https://github.com/pago)! - Fix worktree labels in the workspace header button and session list to show `dir (branch)` when the directory name differs from the checked-out branch, matching the worktree popover list.

## 0.15.0

### Minor Changes

- [#126](https://github.com/pago/simpleedit/pull/126) [`551dc91`](https://github.com/pago/simpleedit/commit/551dc911d8325a2c203e636bfd18087acb9402e8) Thanks [@pago](https://github.com/pago)! - Agent-first UI pivot (Stage 1): sessions replace worktrees as the primary navigation entity. The sidebar lists agent/terminal sessions with live status; each session owns its workspace (tabs, worktree selection, file tree, git log) which is preserved across switches. A new session starts as a full-bleed terminal and grows viewer chrome when the first tab opens. Worktrees are demoted to a management section; clicking one repoints the active session's workspace. The Split concept is removed. Session persistence is rekeyed to sessions (save format v2) — agent sessions restore as click-to-resume entries with their tabs.

- [#127](https://github.com/pago/simpleedit/pull/127) [`1b4d0e2`](https://github.com/pago/simpleedit/commit/1b4d0e2cb81e83a16a369d01cc2e1ce733e675b1) Thanks [@pago](https://github.com/pago)! - Stage 4 — multi-repo sessions. A session's workspace can now view worktrees from more than one bare repo: a repo picker (left of the worktree picker) points the viewer at another repo's worktrees without changing the session's launch dir or model. The `worktree:*` IPC handlers take an optional `repoPath` (the per-window repo map stays as the single-repo default), the cwd→worktree resolver matches across all of a window's opened repos, and per-session `repoPath` persists across restart. Recently-viewed deferred.

- [#126](https://github.com/pago/simpleedit/pull/126) [`3b45c86`](https://github.com/pago/simpleedit/commit/3b45c86e00715624398e69c614cf3034eb19b7a0) Thanks [@pago](https://github.com/pago)! - Session location tracking (Stage 2). Spawned Claude sessions now report their working directory to SimpleEdit via injected HTTP hooks, and the session's workspace (file tree, git log, diff targets) automatically follows the agent into whichever worktree it's working in. Adds two MCP tools so agents can drive the UI directly: `open_worktree` (repoint the workspace) and `show_diff` (open a diff tab).

### Patch Changes

- [#124](https://github.com/pago/simpleedit/pull/124) [`5b195d5`](https://github.com/pago/simpleedit/commit/5b195d58a9bff68f1f8d02528c1db8392614eb55) Thanks [@pago](https://github.com/pago)! - fix: upgrade @electron/rebuild so node-gyp can find Visual Studio 2026

  The Windows release build failed at install with "Could not find any Visual Studio
  installation to use". GitHub migrated the `windows-latest` runner to Visual Studio 2026,
  which node-gyp only learned to detect in v12.1.0. The pinned `@electron/rebuild@4.0.3`
  pulled in node-gyp 11.x transitively. Bumping to `@electron/rebuild@^4.0.4` resolves
  node-gyp ^12.2.0, restoring native rebuilds of node-pty on Windows.

## 0.14.1

### Patch Changes

- [#122](https://github.com/pago/simpleedit/pull/122) [`2aa11db`](https://github.com/pago/simpleedit/commit/2aa11db5b77fdf447019a14d0ded4805975ba454) Thanks [@pago](https://github.com/pago)! - Tours delivered by an agent over MCP now render their code diffs (collapsed by default) instead of narration text only — the same view the normal tour uses. Expanding a tour snippet now scrolls to the referenced change instead of showing the file at line 1.

- [#122](https://github.com/pago/simpleedit/pull/122) [`e7a1a01`](https://github.com/pago/simpleedit/commit/e7a1a01e3ee158ad33622831d626f19aa74a9cbd) Thanks [@pago](https://github.com/pago)! - Worktrees panel now surfaces the on-disk directory name when it differs from the checked-out branch (e.g. a directory `improvements/` holding branch `main` shows as `improvements (main)`), so the path is no longer hidden. When the directory and branch match, only the single name is shown.

- [#122](https://github.com/pago/simpleedit/pull/122) [`e93a2d3`](https://github.com/pago/simpleedit/commit/e93a2d3b73703ce5a129b2c4503877eccf4c180e) Thanks [@pago](https://github.com/pago)! - Worktrees panel now refreshes automatically when worktrees are added, removed, or moved outside SimpleEdit (e.g. `git worktree add/remove/move` from a terminal). Previously the sidebar showed a stale list until an in-app action or restart triggered a refresh.

## 0.14.0

### Minor Changes

- [#116](https://github.com/pago/simpleedit/pull/116) [`d30733c`](https://github.com/pago/simpleedit/commit/d30733ce91776d1c697f64dd5cfe7494e914a1b5) Thanks [@pago](https://github.com/pago)! - The Fork-into-worktree picker can now create a new worktree on the fly: type a name that doesn't match an existing worktree and the first row becomes "Create new worktree '<name>'". Selecting it creates the worktree/branch with that name, then forks the session into it.

- [#98](https://github.com/pago/simpleedit/pull/98) [`f30399b`](https://github.com/pago/simpleedit/commit/f30399b20eb540b1ca22ed64dd887eab9f970891) Thanks [@pago](https://github.com/pago)! - Refs [#87](https://github.com/pago/simpleedit/issues/87) (PR2 of 3): wire up the "Close session" item in the agent tab context menu. Picking it calls the existing `closeTab` flow (which detaches any stream parser and kills the PTY). Works for both Claude and Agent View tabs.

  Stacked on [#93](https://github.com/pago/simpleedit/issues/93). Fork item remains a disabled placeholder until PR3.

- [#101](https://github.com/pago/simpleedit/pull/101) [`c8d30c0`](https://github.com/pago/simpleedit/commit/c8d30c0731e922afa996e4255a3e917a65eacdd8) Thanks [@pago](https://github.com/pago)! - Fixes [#87](https://github.com/pago/simpleedit/issues/87): enable Fork-into-worktree execution behind `SIMPLEEDIT_EXPERIMENTAL_FORK=1`.

  Right-clicking a Claude tab now offers a real "Fork into worktree…" entry (gated by the experimental env var introduced in PR3). Picking it opens an inline worktree picker; choosing a target worktree forks the source Claude session into it: SimpleEdit pre-mints the fork's session-id, copies the source transcript (and any subagent subdir) into the target's `~/.claude/projects/...`, then spawns `claude --session-id <new> --resume <src> --fork-session` in the target cwd. The new tab appears as an italic-dimmed placeholder until Claude emits its first byte, at which point it transitions to a live Terminal. Fork failures auto-clear after ~6s.

  Agent View tabs cannot be forked (the TUI emits no session id); the menu item is disabled with a dedicated tooltip. The auto-memory dir (`~/.claude/projects/<cwd>/memory/`) is intentionally NOT copied — it's project-scoped, not session-scoped, and copying would pollute the target worktree's existing memory.

  Stacked on [#101](https://github.com/pago/simpleedit/issues/101).

- [#109](https://github.com/pago/simpleedit/pull/109) [`97f87b4`](https://github.com/pago/simpleedit/commit/97f87b4bb1f9c42b3c9b28cec7ce91362b034523) Thanks [@pago](https://github.com/pago)! - Fixes [#87](https://github.com/pago/simpleedit/issues/87) (rename + menu skeleton; fork and close in follow-up PRs).

  Adds a context menu to agent terminal tabs (Claude and Agent View). The menu surfaces "Rename…" today; "Fork into worktree…" and "Close session" appear as disabled placeholders that future PRs will wire up.

  - The menu opens on right-click, click of the new `⋯` overflow button (visible on hover/focus), Shift+F10, or the ContextMenu key.
  - Rename uses the existing `PromptModal` (moved to `src/renderer/components/` since it now spans features).
  - User-renamed tabs are sticky — `handleTitleChange` early-returns so the PTY's OSC title can't overwrite the chosen label. The `customLabel` flag persists across session save/load, including for Agent View tabs.

  Stacked on [#92](https://github.com/pago/simpleedit/issues/92).

- [#92](https://github.com/pago/simpleedit/pull/92) [`8819854`](https://github.com/pago/simpleedit/commit/88198546bf84297da200158f7bf9c82fcd9bc075) Thanks [@pago](https://github.com/pago)! - Fixes [#90](https://github.com/pago/simpleedit/issues/90): right-clicking the new-Claude (✦) button in the terminal tab strip opens a context menu offering "New Claude session" (existing behavior) or "New Agent View session" (`claude agents` — interactive TUI). Shift+F10 and the ContextMenu key also open the menu for keyboard users. Agent View tabs are labelled `Agents` / `Agents N` and spawn through a new `claude:spawn-agents` IPC channel that intentionally skips stream-json parsing and the MCP bridge. Known limitation: Agent View tabs cannot be true session-restored (claude agents emits no session-id), so on app restart they respawn fresh as a new Agent View tab in the original position — position and label persist, in-tab state does not.

  Also extracts a reusable `ContextMenu.svelte` with arrow-key navigation, disabled-item skipping, danger tone, separators, and focus restoration. `FileTreeContextMenu` is unchanged in this PR and will be migrated to the shared component later.

### Patch Changes

- [#106](https://github.com/pago/simpleedit/pull/106) [`873ee3e`](https://github.com/pago/simpleedit/commit/873ee3e2f77316c0f8528a6a90b204379fcdaf2c) Thanks [@pago](https://github.com/pago)! - Remove dead --output-format stream-json codepath. The flag is silently ignored by Claude CLI 2.1.148 in TTY mode (see [#95](https://github.com/pago/simpleedit/issues/95)); session capture now uses --session-id via [#102](https://github.com/pago/simpleedit/issues/102).

- [#102](https://github.com/pago/simpleedit/pull/102) [`1f1dcfa`](https://github.com/pago/simpleedit/commit/1f1dcfa6bf786648ff9056bc00d229f0d90b76e8) Thanks [@pago](https://github.com/pago)! - Fix Claude session_id capture for fresh tabs. The CLI's `--output-format
stream-json` is silently ignored when stdin is a TTY (which `node-pty`
  always provides), so the existing stream-json parser in `claude-stream.ts`
  captured nothing for any fresh Claude tab — breaking the rename-restore
  feature and blocking the Fork-into-worktree precursor.

  Replaced the broken path with `--session-id <uuid>`: mint a UUID with
  `crypto.randomUUID()` at spawn time, pass it on the claude CLI, and emit
  `claude:session-id` synchronously to the renderer. No filesystem watcher
  or first-message race involved.

- [#111](https://github.com/pago/simpleedit/pull/111) [`3c94627`](https://github.com/pago/simpleedit/commit/3c946278541c203f030146f13907bff6029419a1) Thanks [@pago](https://github.com/pago)! - Add a fake claude binary fixture for e2e tests, eliminating CI flakes when the real claude binary is absent.

- [#113](https://github.com/pago/simpleedit/pull/113) [`ec43468`](https://github.com/pago/simpleedit/commit/ec4346816cb8f06e3576246cc46b1a2eff9a8665) Thanks [@pago](https://github.com/pago)! - The fake claude binary used by e2e tests now emits a startup line. Tests that wait on `pty:data` to discover the terminal id (e.g. agent-view-sticky-label) need at least one event from the PTY; without output, they timed out at 10s.

- [#101](https://github.com/pago/simpleedit/pull/101) [`c277861`](https://github.com/pago/simpleedit/commit/c27786152c272b5a3242eddc9927e276b274a1bd) Thanks [@pago](https://github.com/pago)! - Fork-into-worktree tabs now drive the worktree's Claude status indicator the same way regular Claude tabs do — the stream parser is attached at fork time so OSC-title status events (✳ idle / ⠂ braille spinner) flow into the sidebar badge. Fixes [#103](https://github.com/pago/simpleedit/issues/103).

- [#101](https://github.com/pago/simpleedit/pull/101) [`5c676c4`](https://github.com/pago/simpleedit/commit/5c676c4c3e0773f264211880e058fa9bef474aa1) Thanks [@pago](https://github.com/pago)! - Fork-into-worktree menu item is now available without an experimental gate. The execution path (PR [#104](https://github.com/pago/simpleedit/issues/104)) has comprehensive safety nets — env var gating was originally introduced for caution but proved redundant given the per-tab disable logic.

- [#91](https://github.com/pago/simpleedit/pull/91) [`2f6fdaa`](https://github.com/pago/simpleedit/commit/2f6fdaa7f834754ba0af13979df348f95c6eb9a9) Thanks [@pago](https://github.com/pago)! - Fixes [#89](https://github.com/pago/simpleedit/issues/89): resolve the "main" worktree by reading the bare repo's default branch instead of trusting the porcelain list order. With a bare repo, `git worktree list --porcelain` could return a non-default branch first (alphabetically), causing SimpleEdit to suppress the delete button on the wrong worktree.

- [#110](https://github.com/pago/simpleedit/pull/110) [`a4091d6`](https://github.com/pago/simpleedit/commit/a4091d696e45815ce7a9167ab345f5a4e165a658) Thanks [@pago](https://github.com/pago)! - Agent View tab labels (`Agents`, `Agents 2`, …) now stay sticky and aren't overwritten by the TUI's xterm OSC title. Fixes [#94](https://github.com/pago/simpleedit/issues/94).

- [#112](https://github.com/pago/simpleedit/pull/112) [`3b56222`](https://github.com/pago/simpleedit/commit/3b56222293256cf726359332893b5c86c1dff1bb) Thanks [@pago](https://github.com/pago)! - Tab strip and rename modal a11y polish: the outer tab is now a `<div role="tab">` instead of a `<button>` with nested `<button>`-ish spans, the ⋯ overflow + close icons are real `<button>` siblings, and `PromptModal`'s dialog div gains `tabindex="-1"` (plus an `untrack`-seeded initial value so Svelte stops warning about `state_referenced_locally`). Fixes [#97](https://github.com/pago/simpleedit/issues/97).

- [#117](https://github.com/pago/simpleedit/pull/117) [`b73e0d7`](https://github.com/pago/simpleedit/commit/b73e0d7942c0ea60bde3ed8cdad6fc337a16e8d5) Thanks [@pago](https://github.com/pago)! - Three pre-release fixes in the terminal/status area:

  - The worktree Claude status indicator no longer sticks on "running" after a Claude tab is closed mid-run ([#114](https://github.com/pago/simpleedit/issues/114)). Status is now tracked per-terminal and pruned on PTY exit, so a worktree drops back to idle when its last active Claude terminal goes away — and two Claude tabs in the same worktree no longer clobber each other's status.
  - A renamed Claude tab's custom label now reliably survives a quit/relaunch ([#100](https://github.com/pago/simpleedit/issues/100)). The session-restore drain now reacts to late-staged resumes, fixing a mount-vs-hydrate race that could drop the restored tab.
  - Removed the dead `--output-format stream-json` flag from the forked-Claude spawn ([#107](https://github.com/pago/simpleedit/issues/107)); it's ignored under a TTY on recent CLI versions.

- [#99](https://github.com/pago/simpleedit/pull/99) [`8f4f1a3`](https://github.com/pago/simpleedit/commit/8f4f1a34cd804a30eef3977830f8cb73dee95b9f) Thanks [@pago](https://github.com/pago)! - Fix long-running terminal sessions (tmux, Claude agent teams) disappearing on
  worktree switch. Terminal ids were minted as `term-${Date.now()}-${nextIndex}`,
  which collided whenever PaneManager mounted several WorktreePanes in the same
  tick — common during session restore. Multiple Terminal components then attached
  to the same PTY id, wedging their xterm renderers. Switched to `crypto.randomUUID()`.
  Fixes [#88](https://github.com/pago/simpleedit/issues/88).

## 0.13.1

### Patch Changes

- [#85](https://github.com/pago/simpleedit/pull/85) [`88ac99a`](https://github.com/pago/simpleedit/commit/88ac99a471de9ee78563991ade1f95d5d70210b5) Thanks [@pago](https://github.com/pago)! - Make worktree deletion feel instantaneous. Clicking Confirm in the
  Remove dialog now drops the row from the sidebar immediately while
  `git worktree remove` runs in the background — you can queue up the
  next delete without waiting on the previous one to finish. If the
  backend call fails, the row pops back in at its original position and
  the error surfaces above the list, so nothing is lost.

## 0.13.0

### Minor Changes

- [#76](https://github.com/pago/simpleedit/pull/76) [`91f3f4b`](https://github.com/pago/simpleedit/commit/91f3f4b4e66633586bf8054ef8de8379022a60c8) Thanks [@pago](https://github.com/pago)! - Add a right-click context menu to the file tree with **New File**, **New Folder**, **Rename**, and **Delete** actions. New File/Folder accept nested names like `foo/bar.ts` to create intermediate directories. Delete moves to the OS trash via `shell.trashItem` so items are recoverable. The affected portion of the tree refreshes automatically after each operation.

### Patch Changes

- [#84](https://github.com/pago/simpleedit/pull/84) [`7214f89`](https://github.com/pago/simpleedit/commit/7214f892ae63c0e0d565c666e033709cc00af792) Thanks [@pago](https://github.com/pago)! - Stop the editor-opener browser test from leaking unhandled Monaco TypeScript-worker rejections that were failing CI even though every assertion passed.

- [#82](https://github.com/pago/simpleedit/pull/82) [`0b98745`](https://github.com/pago/simpleedit/commit/0b98745cdf7769a296c2f3f5780ac4e2136dfe3f) Thanks [@pago](https://github.com/pago)! - Fix typing wiping out the user's input. When the user typed a character, the resulting modified-flag flip caused the parent to re-render, the load-file `$effect` re-fired even though `filePath` was unchanged, and `loadFile` then reset the model to the disk contents — erasing the typed character and dropping the cursor at (1, 1). The effect now skips when the path matches what's already loaded.

- [#81](https://github.com/pago/simpleedit/pull/81) [`3c77f17`](https://github.com/pago/simpleedit/commit/3c77f17baa51ecdfab6ce6c5f3160bd843a3c554) Thanks [@pago](https://github.com/pago)! - Two follow-up fixes to Go to Definition that the previous wiring missed:

  - **Multiple definitions:** Monaco's default for `gotoLocation.multipleDefinitions` is `'peek'`, which short-circuits before our editor opener can run. Imports very commonly resolve to 2+ locations, so the peek widget kept appearing instead of navigation. The editor now opts into `'goto'` for definitions, declarations, type definitions, and implementations (references stay on peek).
  - **Same-file definitions:** the opener was intercepting in-file navigation and routing it through the host's `openFile`, which dedupes to the already-active tab without re-running the file load — so the cursor never moved. The opener now defers to Monaco's default standalone handler when the source editor's model URI matches the requested resource.

  Covered by new browser-mode tests in `src/renderer/lsp/__tests__/editor-opener.test.ts`.

- [#79](https://github.com/pago/simpleedit/pull/79) [`d40991a`](https://github.com/pago/simpleedit/commit/d40991aded2edc6dfd342220681e2ade87b2b12d) Thanks [@pago](https://github.com/pago)! - Make Go to Definition (and Ctrl/Cmd-click) actually open the target file when it lives in another module. Previously Monaco fell back to the peek widget because the standalone editor's URI opener doesn't know about our tab system; now we register a Monaco editor opener that routes the request through the active pane's `openFile`, and the loaded editor scrolls/selects the LSP-resolved position automatically.

- [#75](https://github.com/pago/simpleedit/pull/75) [`d5e2a14`](https://github.com/pago/simpleedit/commit/d5e2a14a1a7ee77d8a505dd255fff590ed419549) Thanks [@pago](https://github.com/pago)! - Inherit the user's shell PATH on macOS/Linux when launched from Finder/Spotlight, so language servers (and other binaries on PATH like `asdf` shims, homebrew, nvm) can be found. LSP startup failures are also now logged to the renderer console instead of being silently swallowed.

- [#83](https://github.com/pago/simpleedit/pull/83) [`73a4829`](https://github.com/pago/simpleedit/commit/73a48292d66a667e8e3c6f1e6cb4c2abf6888914) Thanks [@pago](https://github.com/pago)! - Middle-click on a tab now closes it, matching VS Code and browser tab behavior.

- [#77](https://github.com/pago/simpleedit/pull/77) [`050e388`](https://github.com/pago/simpleedit/commit/050e38834b12ae9d9dac0eef575aa667df26b9c3) Thanks [@pago](https://github.com/pago)! - Pin the **WORKTREES**, **GIT LOG**, and **FILES** section headers so they stay visible when their lists scroll. The headers stick to the top of each scroll container with a solid background, so action buttons (refresh, + New, ✦ Plan, etc.) remain reachable without scrolling back up.

## 0.12.2

### Patch Changes

- [#73](https://github.com/pago/simpleedit/pull/73) [`9bdac63`](https://github.com/pago/simpleedit/commit/9bdac63b08e9d0590a09e315c3229339a3cd9488) Thanks [@pago](https://github.com/pago)! - Fix three bugs in the v0.12.0 session save/restore feature that surfaced as
  soon as a Claude tab was opened, freezing every subsequent click in the
  renderer:

  - **`effect_update_depth_exceeded` (Svelte 5 infinite-loop guard).**
    `publishClaudeTabs` and the other `sessionRestoreStore` writers cloned
    their own state via `new Map(_state)` and assigned the result back. Inside
    the `$effect` in `TerminalTabs` that publishes Claude tabs on every change,
    that's a tracked-read followed by a write to the same state — Svelte 5's
    canonical loop pattern. Reads are now wrapped in `untrack`.

  - **`DataCloneError` in `flushSessionSave`.** `serializeSession` embedded the
    `_visitedPrimaryPaths` / `_visitedSecondaryPaths` Svelte 5 reactive proxy
    arrays directly in the saved payload. `structuredClone` (used by Electron
    IPC) refuses to clone the proxy. The serializer now spreads them into
    plain arrays.

  - **`hydrateSession` stranding the user with an invisible pane.** The first
    save after the loop bug froze `visitedPrimary: []` to disk. On every
    subsequent launch, hydrate cleared the path that `PaneManager`'s
    add-on-`primaryPath`-change effect had just added — and because
    `primaryPath` didn't transition again, the effect never re-fired.
    `WorktreePane` was never mounted; the editor pane was empty and clicks in
    the Git Log appeared to do nothing. Hydrate now ensures the active
    worktree paths are present in `visitedPrimary` / `visitedSecondary` after
    filtering.

## 0.12.1

### Patch Changes

- [#71](https://github.com/pago/simpleedit/pull/71) [`1877762`](https://github.com/pago/simpleedit/commit/1877762665aba619f2b0fde20160cc854d28e782) Thanks [@pago](https://github.com/pago)! - Fix three bugs in the v0.11 tab/file-tree code:

  - **tabsStore peek-replace leaked stale ids.** When peek B replaced peek A, A's id stayed in the MRU and unread sets and (in the background-replace case) as `activeId`. After a peek-peek-close sequence the pane's `activeId` could point at a tab that no longer existed, defeating the `paneIdle` heuristic — agent plans/tours/panels then opened in the background unread instead of focusing into a visibly empty pane. The replaced peek's id is now pruned, and active focus transfers to the replacement when the slot was the focused one.
  - **Agent panel updates were silent in the background.** `tabsStore.open` only adds the unread marker for _new_ tabs. When `show_panel` updated a panel the user already had open in the background, no marker appeared. `WorktreePane` now adds the marker explicitly when an existing, unfocused panel gets refreshed.
  - **FileNode `loadChildren` race.** `toggle()` and the "Select opened file" reveal effect can each kick off a `loadChildren()` for the same node. If the later call resolved first, an older response could overwrite `children` with stale data. Added a sequence counter so only the most recent call wins.

  Also drops a dead `openDiffTab` import from `WorktreePane.svelte`.

- [#69](https://github.com/pago/simpleedit/pull/69) [`dcc696a`](https://github.com/pago/simpleedit/commit/dcc696a9aabbd96ed9b64ad25d76361ebae095f6) Thanks [@pago](https://github.com/pago)! - Fix critical startup crash where opening any repo threw `ReferenceError: activeFilePath is not defined` from `WorktreePane`'s `<FileTree>` call. The reference was added by the "Select opened file" feature against pre-tabs-refactor code; after the unified tab model landed, `activeFilePath` is no longer a local — derive it from the active tab instead. The render error cascaded into git log not loading and worktree clicks appearing inert because Svelte aborted the reactive batch.

## 0.12.0

### Minor Changes

- [#67](https://github.com/pago/simpleedit/pull/67) [`001ff55`](https://github.com/pago/simpleedit/commit/001ff55ad9d13b24de0c7baf5d6ce3a3a0d32d87) Thanks [@pago](https://github.com/pago)! - Save and restore per-repo session on quit/launch. SimpleEdit now remembers
  which worktrees were open in which panes, what tabs were active in each, and
  which Claude Code sessions were running. On relaunch, the layout and tabs
  come back automatically; Claude sessions appear as click-to-resume placeholder
  tabs so launching the app doesn't fan out N concurrent `claude --resume`
  processes across worktrees.

## 0.11.0

### Minor Changes

- [#59](https://github.com/pago/simpleedit/pull/59) [`60e107e`](https://github.com/pago/simpleedit/commit/60e107e9f1a3c085495265f1b48c3bf4d7f35c4d) Thanks [@pago](https://github.com/pago)! - Add `complete_task` MCP tool that lets Claude agents deliver a guided review tour directly when they finish a chunk of work — no separate Claude spawn, richer context, lower cost. Tours attach to the provided commit hash or to staging. Open questions render as an attention banner plus a list below the tour. Tool descriptions for `show_plan` and `complete_task` are directive ("ALWAYS use this tool when…") so agents pick them up without prompting.

- [#64](https://github.com/pago/simpleedit/pull/64) [`87ab22a`](https://github.com/pago/simpleedit/commit/87ab22ae4b084c1a778281d18a64388772269388) Thanks [@pago](https://github.com/pago)! - Add a generative UI pipeline so Claude can compose panels at runtime instead of every interaction type requiring its own bespoke MCP tool. A new `show_panel(spec)` tool accepts a Zod-validated JSON spec built from a catalog of 13 primitives (prose, file lists, code snippets, decision cards, status indicators, key-value summaries, sections, action buttons, text inputs, callouts, rows, and graph/sequence diagrams). User interactions in the rendered panel route back to the originating Claude session via an enumerated capability set (`send_to_agent`, `open_file`, `show_diff`, `dismiss_panel`, `set_state`), with rate limiting on the agent-write path and main-side validation rejecting paths outside the active worktree. Diagrams ship with two backing technologies behind one primitive: graph kind via Svelte Flow + ELK, sequence kind via mermaid compiled from typed JSON (the agent never produces mermaid DSL). The Diagram dependencies (`@xyflow/svelte`, `elkjs`, `mermaid`) are dynamic-imported so panels that don't include a diagram pay nothing for them.

- [#66](https://github.com/pago/simpleedit/pull/66) [`f523c00`](https://github.com/pago/simpleedit/commit/f523c005223a9d72822eafd15503aa8b05dc043e) Thanks [@pago](https://github.com/pago)! - Add a "Select opened file" button to the Files panel that expands the path to the active editor tab and scrolls it into view — useful after locating a file via Cmd+K.

- [#65](https://github.com/pago/simpleedit/pull/65) [`7ca61ae`](https://github.com/pago/simpleedit/commit/7ca61ae7a586781a4e0517df68e8844f6ed8d219) Thanks [@pago](https://github.com/pago)! - Drag and drop files onto the terminal to attach them. Drops from Finder paste the absolute path; drops from a browser or anywhere else without a filesystem path are saved to a temp file under `simpleedit-drops/` and the path is pasted instead. Multiple paths use newline separators in Claude terminals (matching Claude Code's parser) and shell-escaped, space-separated paths everywhere else.

- [#63](https://github.com/pago/simpleedit/pull/63) [`1412459`](https://github.com/pago/simpleedit/commit/1412459369ef499377a48977ca32ec2ddf2b7760) Thanks [@pago](https://github.com/pago)! - Replace the per-pane mix of editor / DiffReview / PlanView / TourPanel content modes with a unified per-worktree tab model. Files, diffs, tours, and plans are now sibling tabs in a single tab bar — multiple diffs can be open at once, plans and tours sit alongside the diff that spawned them, and clicking a commit in the GitLog opens its diff as a peek tab (replaced by the next peek action unless pinned via double-click). Each tab kind has a distinct leading icon for at-a-glance scanning. Agent-initiated content (plans, tours via existing MCP tools) auto-focuses when the pane is idle and otherwise opens in the background with an unread marker that clears on focus. The GitLog gains a trailing tour icon that opens (or focuses) a tour tab for the commit, and stays persistently highlighted on commits that already have a tour. The command palette gains "Tour commit: …" entries for the most-recent commits in the active worktree.

## 0.10.1

### Patch Changes

- [#51](https://github.com/pago/simpleedit/pull/51) [`c43fe76`](https://github.com/pago/simpleedit/commit/c43fe763aaca92c30b134b676f3f8e47af25d9fd) Thanks [@pago](https://github.com/pago)! - Fix Claude-originated plans not appearing by using the authoritative worktree path from the terminal attachment instead of relying on the path Claude provides in the show_plan tool call.

## 0.10.0

### Minor Changes

- [#49](https://github.com/pago/simpleedit/pull/49) [`2a5f94f`](https://github.com/pago/simpleedit/commit/2a5f94fe2c00e73677bba2b5826003eb1fbcfe28) Thanks [@pago](https://github.com/pago)! - Add Claude-originated plan support via MCP bridge. When Claude Code calls the `show_plan` MCP tool from an interactive terminal session, the plan is displayed in Plan Mode with a feedback loop back to the originating session. Includes plan persistence across app restarts, toast notifications, session-aware task routing, and per-task feedback that routes to Claude.

### Patch Changes

- [#46](https://github.com/pago/simpleedit/pull/46) [`b6a235c`](https://github.com/pago/simpleedit/commit/b6a235ca3b62eb8bc8504de6022b40cc986b574d) Thanks [@pago](https://github.com/pago)! - Fix terminal height not updating on resize due to undefined `buf` reference in `fitPreservingScroll`.

- [#47](https://github.com/pago/simpleedit/pull/47) [`c43bbdc`](https://github.com/pago/simpleedit/commit/c43bbdc680f7c4dbe0e509704cb1397689c962e1) Thanks [@pago](https://github.com/pago)! - Fix plan mode: deduplicate plan form and auto-complete tasks when Claude finishes.

  - PlanView no longer shows two description forms (PlanPanel's empty-state input is suppressed when embedded in PlanView)
  - Plan tasks now transition from "in-progress" to "done" when the associated Claude terminal goes idle
  - claude:status IPC event now includes terminalId for per-terminal tracking

## 0.9.0

### Minor Changes

- [#44](https://github.com/pago/simpleedit/pull/44) [`45a37ed`](https://github.com/pago/simpleedit/commit/45a37edcdb0798b6b818cc621ed650a7bb8ce33b) Thanks [@pago](https://github.com/pago)! - Add Plan Mode for user-driven implementation planning with Claude.

  - New "✦ Plan" button in Git Log sidebar opens a full-pane plan view
  - Describe what you want to build, Claude generates an actionable task list
  - Emoji reactions (👍 👎 ❓ 🚀 👀) for quick task feedback
  - Per-task feedback triggers automatic plan revision
  - General "Adjustments" field for plan-wide revisions
  - "Start" button on each task spawns a Claude agent to implement it
  - "Start All" button to kick off the entire plan
  - Task status cycling (To Do → In Progress → Done → Rejected)
  - Plans persist to disk across app restarts
  - Plan tab also available in diff review for commit-scoped planning

## 0.8.0

### Minor Changes

- [#42](https://github.com/pago/simpleedit/pull/42) [`0fa03c7`](https://github.com/pago/simpleedit/commit/0fa03c72ac3301036e3dd66b3c2136fc5851a884) Thanks [@pago](https://github.com/pago)! - Add command palette (Cmd+K) for fast keyboard-driven navigation to files, worktrees, actions, and commits. Supports prefix-based filtering (> actions, @ worktrees, # commits) and fuzzy matching with filename-aware scoring.

- [#43](https://github.com/pago/simpleedit/pull/43) [`0d699be`](https://github.com/pago/simpleedit/commit/0d699bedc72e162c0d7b32581cddd62196b09087) Thanks [@pago](https://github.com/pago)! - Add collapsible file tree panel with persistent state via localStorage.

### Patch Changes

- [#38](https://github.com/pago/simpleedit/pull/38) [`9cc9e8e`](https://github.com/pago/simpleedit/commit/9cc9e8e210b57ef8c2f436551d593602ade542cc) Thanks [@pago](https://github.com/pago)! - Creating a worktree with "+ New" now checks out the existing branch instead of failing when a branch with that name already exists.

- [#38](https://github.com/pago/simpleedit/pull/38) [`50f4fdc`](https://github.com/pago/simpleedit/commit/50f4fdc104b2c544cdb42ddd766a7be0258972f1) Thanks [@pago](https://github.com/pago)! - Fetch remote refs before listing branches in the checkout panel so newly pushed branches are visible.

- [#41](https://github.com/pago/simpleedit/pull/41) [`d84909f`](https://github.com/pago/simpleedit/commit/d84909f980aba0d6b89566170fb595157b771af4) Thanks [@pago](https://github.com/pago)! - Fix clicking links in terminal sessions. The xterm.js WebLinksAddon default handler
  used `window.open()` which is blocked by Electron's popup policy. Links now open in
  the default browser via a new `app:open-external` IPC channel.

- [#39](https://github.com/pago/simpleedit/pull/39) [`a9e4251`](https://github.com/pago/simpleedit/commit/a9e4251db47d0189c5032fc45579d60b11c70f7b) Thanks [@pago](https://github.com/pago)! - Fix terminal output rendering in a narrow strip after tab switches. The ResizeObserver was firing on hidden containers (display:none), causing fitAddon to calculate 0 columns and corrupt the PTY.

- [#39](https://github.com/pago/simpleedit/pull/39) [`8a81624`](https://github.com/pago/simpleedit/commit/8a816240ed34c2e0afb523ca5500ca26b703dc8d) Thanks [@pago](https://github.com/pago)! - Fix terminal scrolling to top when content arrives or the container resizes. Scroll position is now preserved across fit() calls, tab switches, and incoming PTY data when the user has scrolled up.

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
