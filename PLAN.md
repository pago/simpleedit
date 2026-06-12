# Agent-First UI Pivot

SimpleEdit's current model is project → worktree → agent: you open a repo, navigate
by worktree, and agents live inside panes. That no longer matches the actual
workflow, where the **agent session is the unit of attention** and worktrees are an
isolation mechanism the session *uses*. This plan inverts the hierarchy: sessions
become the primary navigation entity; the viewer (editor/diff/git log) becomes
per-session workspace state.

Prior art in the tracker: #57 (WorktreeList → review queue) and #54 (worktree
handoff with resume) are both symptoms of this mismatch and are superseded by
Stages 1 and 3 respectively. #80 (briefs) is untouched — it composes with this
model rather than competing. #95 (CLI compatibility audit) graduates from "audit"
to prerequisite.

---

## Target model

```
┌─ Title bar (drag region, project name) ──────────────────────────────┐
├─ Sessions ──┬─ Workspace (per session) ───────────────────────────────┤
│             │ ┌──────────────────────────────┬─ [worktree ▾] [repo ⊕] │
│ ✦ agent 1 ● │ │                              │  Recently viewed       │
│ ✦ agent 2 ◐ │ │  Editor / DiffReview         │ ─────────────────────  │
│ ✦ agent 3 ○ │ │  (hidden until first opened) │  File tree             │
│ $ terminal  │ │                              │ ─────────────────────  │
│             │ ├──────────────────────────────┤  Git log               │
│ [+ Agent]   │ │  Terminal (full-bleed when   │                        │
│ [+ Term]    │ │  no viewer is open)          │                        │
└─────────────┴─┴──────────────────────────────┴────────────────────────┘
```

- **Left panel: sessions, not worktrees.** Each entry shows live status
  (working / awaiting input / idle / error). It is an *inbox* —
  "which agent needs me right now". Exited sessions never linger: every entry
  has a close button (sends exit to the agent), and a session that exits —
  via the button or manually in the terminal — auto-closes its tab.
- **Projects stay as the entry point.** The Welcome screen is unchanged; a
  "project" is the directory you launch sessions from (chosen for Claude memory
  locality). Opening a project shows its persisted sessions plus the new-session
  panel.
- **Progressive disclosure.** A new session starts as a full-bleed terminal.
  Opening any viewer (editor / diff / git log) shrinks the terminal to roughly
  today's proportions. Git log lives in the right column with the file tree,
  under a worktree dropdown + repo picker.
- **Per-session workspace.** Open files, active diff, file-tree root, git-log
  scope, and worktree selection all belong to the session. Switching sessions
  swaps the entire right side; returning to a session restores exactly what you
  were reviewing.
- **The Split concept is removed.** One session, one workspace.

## Design decisions (and why)

| Decision | Rationale |
|---|---|
| Sessions are durable, not a live process list | Reopening a project shows yesterday's non-exited sessions as resumable tabs; clicking resumes via `claude --resume <id>` spawned in the persisted launch dir. The panel is an inbox, so it must survive restarts. |
| Workspace state is per-session | The killer feature is the agent↔human bridge ("Discuss with Agent"). A viewer with exactly one owning session makes the target agent unambiguous, and attached context (file, selection, diff hunk) is guaranteed to concern a worktree that agent knows. |
| Terminals are ephemeral | A dead shell can't resume; plain terminal tabs simply don't persist. |
| Location tracking via hook events, not a plugin | Verified against official docs: every hook event carries `cwd`; a dedicated `CwdChanged` hook fires on directory/worktree changes; `--include-hook-events` surfaces these on the stream-json stdout we already parse. Zero plugin infrastructure for sessions we spawn. |
| MCP stays the agent→UI channel | The bridge already exists (`show_panel`, `show_plan`, tours). "Open the worktree" / "show me the diff" become MCP tools that drive the owning session's workspace. |
| Manual worktree chooser is the fallback, not the primary mechanism | cwd tracking covers spawned sessions; an HTTP-hook fallback can cover externally started ones later. The dropdown remains for overrides and multi-repo sessions. |
| The content area is a single tabbed widget | File tree and git log clicks open editor tabs; the diff view is itself a tab in the same strip. No side-by-side content within a workspace — "diff vs. file" is a tab switch, cheap because tabs are preserved per session. Surrounding panels (left/right/bottom) keep their screen space regardless of which tab is active. |
| One project per window | Each window is a project; nothing fancier. The per-window concept survives — only the per-window *repo* routing goes away (Stage 4). |

---

## Stage 0 — Prerequisite: CLI compatibility (#95) ✓ audited 2026-06-12, CLI 2.1.175

Empirical findings that re-shape Stage 2:

- `--output-format stream-json` is **silently ignored when stdin is a TTY**
  (node-pty always is) — the root cause of #95. The spawn already works around
  this: the flag was dropped and main pre-pins `claude --session-id <uuid>`,
  emitting `claude:session-id` at spawn with no stdout scraping.
- Consequence: **hook events cannot be read off the PTY stream** for
  interactive sessions. Location tracking must use real hooks (Stage 2).
- `CwdChanged` did not fire on 2.1.175 (`-p` mode); every hook's input JSON
  still carries `cwd`, so per-event cwd is the signal, not the dedicated event.
- `--resume <sessionId>` works from any directory and **preserves the
  session id** — validates resume (Stage 3) and fork (#87).
- Tool-use paths are absolute but symlink-resolved (`/tmp` → `/private/tmp`
  on macOS) — normalize before comparing against worktree paths.

## Stage 1 — Core pivot (supersedes #57)

The layout inversion, with a manual worktree chooser; works day one without
Stages 2–4.

- Sessions panel replaces WorktreeList as the sidebar's primary content; entries
  carry the existing `claude-status` states and a close button (sends exit to
  the agent). Any session exit — button or manual — auto-closes the tab.
- Session titles derived from the first prompt, user-editable (rename in place).
- New-session panel when a project is opened (start agent / start terminal).
- Per-session workspace: rekey today's per-pane state (`WorktreePane`) from
  worktree → session. Keep-alive across session switches.
- Progressive disclosure: terminal full-bleed until a viewer opens.
- Right column: worktree dropdown above file tree + git log ("open worktree"
  chooser is the Stage-1 way to point the workspace somewhere).
- Remove Split / dual-pane from `PaneManager`.

## Stage 2 — Session location tracking

Mechanism (revised after the Stage 0 audit): interactive PTY sessions emit no
stream-json, so the **HTTP-hook endpoint is the primary channel**, not a
fallback. SimpleEdit runs a localhost server and installs hook config (via the
`--settings` flag on spawn) that POSTs hook inputs — every hook event carries
`cwd` and `session_id`, which routes to the owning session.

- Localhost hook endpoint in main; hook config injected at spawn.
- Default the session's worktree selection to the tracked cwd (normalize
  symlinks before matching against worktree paths).
- MCP tools for "open the worktree" / "show the diff" targeting the calling
  session's workspace.
- Externally started `claude` sessions get the same hooks via user-level
  settings — same endpoint, sessions matched by `session_id`.

## Stage 3 — Session persistence + resume (supersedes #54)

- Per-project session registry in userData (pattern: `recent-repos.ts`):
  `session_id`, title (incl. user renames), launch dir, last tracked
  cwd/worktree, last status.
- Graceful exit (close button or manual exit in the terminal) drops the session
  from the registry — matching the auto-closed tab. Only
  app-quit-while-running keeps a session as resumable.
- Click a persisted session → respawn `claude --resume <id>` in its launch dir.
- Terminals are not persisted.

## Stage 4 — Multi-repo sessions

The most invasive plumbing change and the most deferrable; everything above
works single-repo.

- Replace the per-window `Map<webContents.id, repoPath>` routing with
  per-session (or per-workspace) repo context across all IPC namespaces.
- Repo picker next to the worktree dropdown (point the workspace at another
  bare repo mid-session).
- Global "Recently viewed" list (spans repos/worktrees) above the file tree.

## Out of scope (deliberately)

- Notifications when a background session flips to "awaiting input" — natural
  follow-up once the inbox exists.
- Briefs (#80) — composes with this model; unchanged.
- AI narration, signing — still v2 per CLAUDE.md.

