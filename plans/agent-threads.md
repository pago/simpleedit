# Plan: Agent threads

Status: planned, revised after adversarial review round 1 · Branch: `feat/agent-threads` ·
Worktree: `../agent-threads`. This plan is committed for the life of the branch. The
branch's final commit deletes it, and its durable parts move into `CLAUDE.md`.

> Line-anchored comment threads between the user and the agent session, in the file editor
> and the session's diff view, working like artifact comments. You comment on a line. The
> agent acts and/or answers in the thread. You append, reopen or resolve. The feature is
> built by extending **Discuss with Agent** with a thread id and adding an MCP tool to answer
> a thread. There is no new transport.

## Why

The terminal conversation is linear, and its references ("that function", "the second point")
are implicit. A thread pins the conversation to the code it is about, lets each topic
progress on its own, and keeps the record next to the line. The user already prefers
artifacts over SimpleEdit for exactly this.

## Key decision: user comments are not agent mail

Agent-to-agent mail has to wake a session nobody is watching. That is the hard, unreliable
part of `agent-bus.ts` and `agent-wake.ts` (#197, #198, #201). A thread comment is sent by a
user who is present, which is close to the user typing a prompt. So threads do **not** go
through the bus and do not depend on #201. The design that remains: send only at a safe
moment, confirm delivery, and attach an answer even when the agent doesn't call the tool.

Rejected on 2026-10-08:
- **Claude Code channels.** Research preview. It needs a `--dangerously-load-development-channels`
  dialog on every launch and claude.ai or Console auth, and it gives no delivery
  acknowledgement.
- **Monitor or a CLI the agent listens to.** The agent has to choose to start it, it has a
  5–30 min deadline, and it is disabled under `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`
  (local-model sessions).
- **A bundled mod's `$.prompt.submit` (#201).** Claude-only and early-access. It is still the
  upgrade path if PTY sends prove flaky, since `$.prompt.read` would also solve the draft
  problem below.

## How it works

### Data model (main-owned store in SQLite, op layer modelled on `screenprs-drafts.ts`)

- `AgentThread`: `id`, `sessionId` (owning agent session), `worktreePath`, `anchor`,
  `status: open | resolved`, `messages[]`, `lastReadAt`, `createdAt`, `updatedAt`.
- `anchor`:
  - `path`, stored relative to the worktree.
  - `startLine`, `endLine`.
  - `snippet`, plus `before` and `after` (2–3 context lines each), for re-anchoring.
  - `context: 'file' | { commit: sha | 'uncommitted', base?: sha }`. A thread on a commit
    diff is anchored to immutable content and is never re-anchored. The `commit` field is
    also what a later GitHub mapping (`commit_id`, side) needs.
  - `orphaned?: true`.
- `ThreadMessage`: `id`, `author: 'user' | 'agent'`, `body` (markdown), `at`. User messages
  also have `delivery: held | sending | delivered | answered | answered-implicitly |
  unanswered | failed`, with `heldReason` and `failedReason`.
- **Stored in SQLite via the built-in `node:sqlite`.** It was verified in Electron 42.5
  (Node 24.17, SQLite 3.53) and works on the CI/test Node 22, which only prints an
  ExperimentalWarning.
  - There is one app database, `userData/config/simpleedit.db`, with WAL enabled and
    migrations driven by `PRAGMA user_version`. Threads are its first tenant. The
    existing JSON stores stay as they are.
  - Tables: `threads`, `thread_messages`, `thread_tombstones`, and `meta` (holding `rev`).
  - Each op is one transaction.
  - All access goes through one module (`src/main/db.ts`), because the `node:sqlite`
    API is not yet stable and an Electron bump could change it.
  - Why not JSON:
    - Delivery transitions are frequent, and each would rewrite the whole file.
    - Threads accumulate across sessions without bound.
    - Reads are queries: by session, by file, and unread counts.
    - Later tenants are relational too: GitHub review threads (#186), persisted agent
      mail (the bus is in-memory today), and the session backlog.
- Ops:
  - `add-thread`, `append`, `set-status`, `remove-thread`.
  - `set-anchor` (re-anchor and orphan).
  - `mark-read`.
  - `set-delivery` (main-only, never accepted from a client).
- `rev`, tombstones (a table), and the `agent-threads:changed` broadcast to every client, desktop
  windows and phones alike. Main validates every op, since the phone is a remote client.
  Clients only submit ops. Sending is main's job (below), so a phone and a desktop window
  share one queue per session and can never double-send.
- IPC namespace `agent-threads:*`.

### Sending

`buildAgentMessage` (`src/renderer/lib/agent-message.ts:38`) gets a `thread` variant. The
header carries an **absolute** path: Claude launches at the project root, not in the
worktree, and the editor context already passes absolute paths
(`CodeEditor.svelte:219-222`).

```
[Thread t_3f9a · /abs/path/src/main/agent-bus.ts:411-451]
<fenced snippet>
<user comment>
(Answer in this thread with reply_to_thread("t_3f9a", …). Act on it first if it asks for a change.)
```

A follow-up carries the thread's earlier messages, truncated, so it survives `/compact` and
forks.

**The send moment.** Main owns this. A new `thread-delivery.ts` sits beside `agent-wake.ts`
and reuses its per-terminal state. A thread message is written only when **all** of these
hold:
1. **Idle after a turn ended.** For Claude and Codex this means a `Stop` was answered
   (`endStop`) plus `WAKE_SETTLE_MS`, with nothing since: no `running`, no hook, no key. For
   Claude, the `idle_prompt` Notification also counts as idle. Busy sessions are never
   written to, so there is no mid-turn queueing, no Codex steering, and no merging with the
   user's own prompt. Messages held during a turn go out **batched into one submit** at the
   next idle edge, one header per thread.
2. **No dialog.** Claude gets two new synchronous hooks in `writeHookSettings`
   (`src/main/agents/claude.ts:84-91`): `PermissionRequest`, and `PreToolUse` matched to
   `AskUserQuestion`. Each sets `blocked` *before* its dialog renders. `blocked` is cleared
   only by that tool call's `PostToolUse` (or failure), a `Stop`, or a user-started
   `UserPromptSubmit`, never by a plain `running`. Codex `PermissionRequest` and OpenCode
   `permission.asked` already map to `waiting`.
   - Check against the live CLI whether `PermissionRequest` exists in the current Claude
     Code. Today `parseHookBody` (`cwd-tracker.ts`) reads neither `tool_name` nor
     `tool_use_id`, so add both.
   - Rule 1 already rules out every in-turn dialog. This rule is defense in depth for
     dialogs outside a turn.
3. **No draft.** `inputPending` is **latched** until a `UserPromptSubmit` the user started
   (one without a `[Thread` header), not cleared by any `running`.
   - Otherwise a draft typed mid-turn is forgotten once a Stop-block continuation reports
     `running`.
   - There is **no "Send anyway"**: a bracketed paste plus CR would submit the draft
     merged with the comment.
   - While held, the thread shows "held: unsent text in the terminal" and offers **Copy**.
     It also offers **"My prompt is empty, send"** behind a confirm, which covers the
     case where the user has already cleared the prompt. The user is vouching for an
     empty prompt. A later Claude mod can read the prompt box with `$.prompt.read`
     (#201) and replace this.
4. **A live PTY.** For a `pendingResume` session, offer "Resume and send": resume with the
   batched comment as the initial prompt (`--resume <id> "<prompt>"`).

Providers:
- **OpenCode** always uses its HTTP `prompt_async` (`deliverMessage`, `opencode.ts:519`),
  which never touches the TUI input, so rule 3 does not apply to it.
- **Claude and Codex** use `agentSubmitWrite`.

**Delivery confirmation.** After a write the message is `sending`. It becomes `delivered`
when a `UserPromptSubmit` arrives whose `prompt` contains its `[Thread t_…]` header.
- Add reading `prompt` to `parseHookBody`.
- For OpenCode, confirmation comes from `prompt_async` success plus its event stream.
- With no confirmation within ~10 s, the message becomes `failed` ("the agent didn't
  receive it") with **Retry**, so nothing stays "sent" forever.
- When a PTY exits, every one of its `sending` messages fails and every arm on it expires.

### Replies

New MCP tools are added in `src/main/mcp-server/index.mjs` and dispatched in `mcp-bridge.ts`
`handleToolCall`. Each is scoped by `terminalId` to the calling session.
- `reply_to_thread(threadId, body)` appends an agent message.
  - A thread owned by another session is rejected with a reason the agent can act on:
    "thread t_x belongs to session ‹label›; you are a fork, answer in your terminal".
  - A forked session inherits the conversation, but not the threads.
- `open_thread(path, startLine, endLine?, body)` arrives in slice 3.

**Implicit fallback, armed on delivery and not on send.** The `UserPromptSubmit` that
confirms delivery arms each thread it carries. On that turn's `Stop` (`handleTurnEnd`,
`mcp-bridge.ts:759`), every armed thread that got no `reply_to_thread` receives
`last_assistant_message` and is marked `answered-implicitly`. If the turn ends any other
way, its arms are released and the messages are marked `unanswered` with Retry. That covers
an Esc-interrupted turn (no `Stop`) followed by a user-started `UserPromptSubmit`, and a
PTY exit. A later turn's answer is never attributed to an earlier comment.

### Session lifecycle

- **Hand off (`target: 'replace'`)** moves the old session's threads to the new session id.
- **Fork:** threads stay with the origin, and the fork's `reply_to_thread` is rejected with
  a reason (above).
- **Session deleted:** its threads are removed with it. See open question 3.

### UI

Both session surfaces are Monaco: `CodeEditor` (`TabContainer.svelte:73-82`) and
`DiffReview` → `MonacoDiffEditor` (`DiffReview.svelte:405`). `UnifiedDiffView`'s `belowRow`
is only used by Screen PRs and does not apply here. A single Monaco thread mechanism serves
both:
- A glyph-margin "+", plus `⌘⇧M` and the context-menu action that replaces "Discuss with
  agent", opens a composer view zone under the line or range.
- Each thread is a view zone hosting a Svelte component: messages, composer,
  Resolve/Reopen, and a delivery state with Retry or Copy. A glyph decoration marks
  anchored lines. A resolved thread collapses to its glyph.
- In diff tabs, threads live on the modified side only. The original side is a v1
  non-goal.
- A session-level **threads list** shows open threads with unread badges (from
  `lastReadAt`), and a click opens the anchor. This is how a reply in a file that isn't
  open gets noticed.

### Phone (in from the start)

The phone's session screen already has a Changes pane (`src/web/ChangesPane.svelte` →
`MobileDiff.svelte`). Its rows are read-only today. `MobileDiff.svelte:11-17` itself notes
that it should merge with `PrDiff`'s tappable lines and inline draft comments.
- **Merge the two.** A single phone diff component makes tap handling optional, and its
  inline slot renders either Screen PRs drafts or agent threads.
- **On a line, tap to comment.** The thread shows inline under its row, with append,
  resolve, reopen, and the delivery state (Retry, Copy).
- A **threads list** on the session screen with unread badges, the same as on desktop.
- **No PTY write from the phone for threads.** `SessionScreen.svelte:156` writes with
  `agentSubmitWrite` directly. Thread messages instead go to main as `append` ops, and
  `thread-delivery.ts` sends them under the same rules. That also covers a phone comment
  while the desktop user has a draft in the terminal.
- A push notification for an agent reply, using the existing push path, so a reply reaches
  a phone that isn't open.

### Re-anchoring (main, not the editor)

Main re-anchors a thread whenever its file changes on disk. It uses the worktree watcher
that already exists, so this also runs for files that aren't open. That keeps the list and
the follow-up headers correct.
- If the stored range still equals `snippet`, the anchor stays where it is.
- Otherwise main searches for `before + snippet + after`, then for the snippet alone. A
  match counts only if it is **unique**, with snippet-only matching allowed only for
  snippets of at least 2 non-blank lines or 20 non-whitespace characters. So `}` or a
  blank line never re-anchors.
- If no unique match is found, the thread becomes `orphaned` and is listed under its file
  without a line.
- Moves are persisted with `set-anchor`.
- Threads on commit diffs are skipped.
- Fuzzy diff-mapping is out of scope for v1.

## Slices

1. **Store and delivery, with a minimal UI.**
   - The store with its ops and IPC.
   - `thread-delivery.ts` with the four send rules, and the new Claude hooks with their
     `parseHookBody` fields.
   - Delivery confirmation, `reply_to_thread`, and the delivery-armed fallback.
   - A plain threads list on desktop **and phone**, and "Discuss with Agent" creating a
     thread.
   - Every hold, send, confirm, arm and answer is logged as `[Threads] …` for the audit.
   - Then the **live check**.
2. **Inline threads.** On desktop, view zones and glyphs in both Monaco editors. On the
   phone, the merged diff component with tap-to-comment and inline threads. Plus the
   composer, resolve/reopen, reply push notifications, and re-anchoring in main.
3. **Agent-opened threads.** `open_thread`, plus guidance so agents don't spam threads.
4. **Durable docs.** A `CLAUDE.md` section "Agent threads" next to "Agent-to-agent
   messaging" (`CLAUDE.md:144`). Delete this plan in the final commit.

Later, not on this branch:
- the PR-review variant (GitHub review threads, #186)
- mod-based Claude delivery (#201)

## Live check (gate after slice 1, before slice 2)

Use a dev instance with real `claude`, `codex` and `opencode`. Do **at least 30 sends per
provider**, then audit the `[Threads]` log. Passing means **zero** misrouted answers, zero
messages typed into a dialog, and zero lost messages. Every message must end in `delivered`
or later, or in a visible `failed`/`unanswered` state.

Cases:
- Idle.
- Busy, then sent at the idle edge, including several held messages batched into one
  submit.
- A permission dialog and an AskUserQuestion dialog, each **already open** and also
  **appearing mid-turn** after the comment is held.
- A draft in the prompt.
- An Esc-interrupted turn.
- `/compact`.
- A `pendingResume` session.
- A fork replying to an origin thread.
- Hand-off `replace`.
- A comment sent from the phone while the desktop terminal holds a draft, plus a desktop
  and a phone appending to the same thread at the same time.
- A submit forced to be swallowed (type into a picker first), to confirm `failed` and
  Retry.

Record the explicit `reply_to_thread` rate. If any case fails for a provider, threads stay
disabled for that provider rather than shipping flaky.

## Open questions

1. **Telling the agent about a resolve.** Default: no, resolving stays UI-only.
2. **Thread lifetime.** Default: a thread is tied to its session, and survives hand-off.
