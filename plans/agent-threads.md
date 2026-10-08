# Plan: Agent threads

Status: planned · Branch: `feat/agent-threads` · Worktree: `../agent-threads`
This plan is committed for the life of the branch. The branch's final commit deletes it, and
its durable parts move into `CLAUDE.md`.

> Line-anchored comment threads between the user and the agent session in the file editor
> and the session's diff view. It works like artifact comments: you comment on a line, the
> agent acts and/or answers in the thread, and you append, reopen or resolve. It is built by
> extending **Discuss with Agent** with a thread id, plus an MCP tool to answer a thread. It
> needs no new transport.

## Why

Talking to an agent in the terminal is linear, and every reference in it ("that function",
"the second point") is implicit. A thread pins the conversation to the code it is about. Each
topic progresses on its own, and the record stays next to the line. In practice the user
already prefers artifacts over SimpleEdit for this reason alone.

## Key decision: user comments are not agent mail

Agent-to-agent mail has to wake a session that nobody is watching. That is the hard,
unreliable part of `agent-bus.ts` and `agent-wake.ts` (#197, #198, #201). A thread comment is
sent by the user, who is present, so submitting it into the PTY is equivalent to the user
typing a prompt. We therefore do **not** route threads through the bus and do not depend on
#201. What remains is a send policy (when it is safe to submit) and a reply fallback (when
the agent doesn't call the tool).

Rejected alternatives, from the feasibility discussion of 2026-10-08:
- **Claude Code channels.** Research preview. A local server needs
  `--dangerously-load-development-channels`, which shows a dialog on every launch. It
  requires claude.ai or Console auth, and it does not acknowledge delivery.
- **Monitor or a CLI the agent listens to.** The agent has to decide to start it, it has a
  5–30 minute deadline, and it is disabled under `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`
  (local-model sessions set this).
- **A bundled mod's `$.prompt.submit` (#201).** Good for unattended mail and a possible later
  upgrade here, but Claude-only and early-access. It isn't needed for an attended send.

## How it works

### Data model (main-owned store, modelled on `screenprs-drafts.ts`)

- `AgentThread`: `id`, `sessionId` (the agent session it belongs to), `worktreePath`,
  `anchor`, `status: open | resolved`, `messages[]`, `createdAt`, `updatedAt`.
- `anchor`: `path` (relative to the worktree), `startLine` and `endLine`, `snippet` (the
  anchored lines' text, used for re-anchoring), and `context: 'file' | { diff: base/side }`.
  Also `orphaned?: true` once re-anchoring fails.
- `ThreadMessage`: `id`, `author: 'user' | 'agent'`, `body` (markdown), `at`,
  `delivery` (user messages only): `held | sent | answered | answered-implicitly`.
- Persisted as `userData/config/agent-threads.json`, written atomically. Changed only through
  ops (`add-thread`, `append`, `set-status`, `remove-thread`, `mark-delivery`), with a `rev`
  counter, tombstones and a `agent-threads:changed` broadcast to all clients. The phone gets
  the data for free, but its UI is out of scope for v1.
- IPC namespace `agent-threads:*`, following the IPC namespace convention in `CLAUDE.md`.

### Sending a user message

`buildAgentMessage` (`src/renderer/lib/agent-message.ts:38`) gets a `thread` variant. The
submitted prompt is a header plus the snippet (as today) plus the thread id and an explicit
instruction:

```
[Thread t_3f9a · src/main/agent-bus.ts:411-451]
<fenced snippet>
<user comment>
(Answer in this thread with reply_to_thread("t_3f9a", …). Act on it first if it asks for a change.)
```

A follow-up in an existing thread also carries the thread's earlier messages, truncated, so
it still makes sense after `/compact` or a fork.

The send happens in **main**, not the renderer. That way the guards in `agent-wake.ts` are at
hand and the phone can reuse the same path later. It uses `agentSubmitWrite`, i.e. a real
submit, unlike today's Discuss with Agent, which only stages the text
(`SessionWorkspace.svelte:239-241`). The thread composer replaces the staging step.

**Send policy.** The user is present, so this is looser than the wake path but never unsafe:
- **Dialog up** (`blocked`: a Claude `Notification` other than `idle_prompt`, or a Codex or
  OpenCode `waiting` status): hold the message. It shows as "held: agent is waiting on you"
  and is sent automatically once `beginStop` or `running` clears it. Never type into a dialog.
- **Draft pending** (`inputPending`, any key since the last turn started): hold the message
  and offer **Send anyway**. The signal over-reports, because typing and then deleting text
  still counts, so the user must be able to override it.
- **Busy** (`running`): submit. Claude Code queues a prompt typed mid-turn. Codex and
  OpenCode behaviour is a live-check item (below). For OpenCode, prefer its HTTP
  `prompt_async` (`src/main/agents/opencode.ts:520`) over the PTY if that works.
- **Idle:** submit.

### Agent replies

New MCP tools in `src/main/mcp-server/index.mjs`, dispatched in `mcp-bridge.ts`
`handleToolCall` and scoped by `terminalId` → session:
- `reply_to_thread(threadId, body)`: appends an agent message. Rejects thread ids that don't
  belong to the calling session.
- `open_thread(path, startLine, endLine?, body)` (slice 3): the agent opens a thread on a
  line. This is the agent→user annotation idea that was deferred when Plan Mode was dropped.

**Implicit fallback.** Each sent user message arms an "awaiting reply" entry on its terminal.
On the next `Stop` (`handleTurnEnd`, `mcp-bridge.ts:760`), every armed thread that got no
`reply_to_thread` in that turn receives `last_assistant_message` as an agent message marked
`answered-implicitly`. That guarantees an answer always lands in the thread. The rate of
implicit answers is the metric for whether the tool instruction works.

### UI

Both surfaces in a session are **Monaco**. The editor is `CodeEditor` (file tabs,
`TabContainer.svelte:73-82`), and the diff tab is `DiffReview` → `MonacoDiffEditor`
(`DiffReview.svelte:405`). `UnifiedDiffView`'s `belowRow` slot is only used by Screen PRs,
so it doesn't help here. One Monaco thread mechanism serves both:
- A glyph-margin "+" (or `⌘⇧M` / the context menu replacing the "Discuss with agent" action)
  opens a composer view zone under the selected line or range.
- Each thread is a **view zone** rendering a Svelte component (messages, composer, Resolve or
  Reopen, delivery state). A glyph-margin decoration marks anchored lines, and a resolved
  thread collapses to its glyph.
- In the diff editor, threads attach to the modified side only. Comments on the original side
  are a non-goal for v1.
- **Threads list:** a session-level list of open threads with unread-reply badges. Clicking an
  entry opens the file at the anchor. This is how you notice a reply in a file you don't have
  open.

### Re-anchoring

Monaco decorations track edits made in the editor, but agent edits happen on disk. On
model reload, if the line range's text no longer equals `snippet`, search for the snippet
(exact match first, then trimmed whitespace) nearest to the old line. Move the anchor if
found, otherwise mark the thread `orphaned` and list it under the file without a line. Do not
attempt fuzzy diff-mapping in v1.

## Slices

1. **Store and delivery, with minimal UI.** The thread store and its ops and IPC; the send
   path with its policy; `reply_to_thread` and the implicit fallback; a plain threads list
   panel, plus "Discuss with Agent" creating a thread instead of staging text. Then do the
   **live check**.
2. **Monaco threads.** View zones and glyphs in `CodeEditor` and `MonacoDiffEditor`, the
   composer, resolve and reopen, re-anchoring.
3. **Agent-opened threads.** `open_thread`, plus guidance on when an agent should use it, so
   it doesn't spam threads.
4. **Durable docs.** A new `CLAUDE.md` section "Agent threads", next to "Agent-to-agent
   messaging" (`CLAUDE.md:144`), then delete this plan in the final commit.

Later, not on this branch: phone UI; the PR-review variant (threads mirrored to GitHub
review threads, #186); a mod-based Claude delivery (#201) if PTY submit proves flaky.

## Live check (gate after slice 1, before slice 2)

Use a dev instance with real `claude`, `codex` and `opencode`. Pass means:
1. About ten comments across idle and busy states all arrive as exactly one submitted prompt
   each, never staged, duplicated or merged with each other.
2. With a permission dialog **and** an AskUserQuestion dialog open, the comment is held and
   then sent after the dialog closes. Nothing is typed into the dialog. Verify that Claude's
   `Notification` fires promptly for both dialog kinds, since that is the only Claude dialog
   signal.
3. A pending draft holds the message, and **Send anyway** sends it.
4. The rate of explicit `reply_to_thread` calls is noted. Every message gets an answer either
   way, through the fallback.
5. A reply from a busy turn that handled two threads lands in the right threads.

If 1 or 2 fails for a provider, threads are disabled for that provider rather than shipped
flaky.

## Open questions

- Should a resolved thread tell the agent ("user resolved t_3f9a")? Default: no, it's
  UI-only.
- Thread lifetime: are they tied to the session (lost on session removal) or to the worktree
  (outlive the session)? Default: to the session, with the store keeping them until the
  session is deleted.
