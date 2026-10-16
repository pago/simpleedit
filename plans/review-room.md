# Plan: Review Room

Status: draft for adversarial review · Branch: `feat/review-room` (worktree `wt-review-room`) ·
Prototype: https://claude.ai/artifact/Bk1wpDP1qvUp3J7vqceZNF (replayed stack #183 → #185)

> Replace Screen PRs' `PrDetail` on desktop with a stack-first **Review Room**: one surface where
> screening/overview/deep-review findings, other reviewers' GitHub comments, the user's own notes
> and a **review companion** agent all meet as **threads**. Agents can open the same room for
> their own PR with `request_review`, and the submitted review flows back to them.

## Positioning (the line we do not cross)

The value is the human reviewer's judgement, amplified. Not "run an AI review and post it".

- AI **orients** (overview, tour) and **investigates when asked** (companion, deep review). It
  never **concludes**: findings are suggestions, nothing is posted that the user did not draft or
  accept, and the companion never edits a draft.
- Nothing runs on open except what already ran (screening). Overview and deep review are buttons.
  The companion starts on the first question.

## Locked decisions (from the design session, 2026-10-15/16)

1. **Unit = stack.** A single PR is a stack of one. Posting and verdicts stay per PR.
2. **GitHub only.** Local work is reviewed by having the agent open a (draft) PR; no separate
   local-branch anchoring.
3. **Thread = item + private conversation + optional draft.** Only the draft is ever posted.
   Thread status is `open | done`; "to post" just means the thread has a draft. Per-thread
   controls: ask input (with suggestion chips: fact-check, "is this real?", "right severity?",
   sample questions), *Draft comment / Draft reply*, *Done*. The companion never edits a draft;
   it offers *Redraft from conversation* (accept / keep mine).
4. **Severity lives on the draft only.** The tool's severity shows as its proposal.
5. **Whole-stack threads** post on a layer picked in the draft, default the top PR.
6. **Submit = one review per layer** with its own verdict. Default: Request changes if a blocking
   draft exists, Comment if any drafts, Approve otherwise (= quick approve).
7. **One companion per review**: a real agent session (Claude / Codex / OpenCode + model; default
   in settings, per-review picker). Brief ends with "wait for my instructions". Switching agent
   = new companion that reads the threads back.
8. **Companion terminal docked, collapsed, at the bottom.** Order: post bar, companion bar
   (terminal toggle on the left, agent picker, status), terminal last. Replaces *Discuss with
   Agent* on desktop. Permission prompts show as "needs you" on the bar; it never auto-expands.
9. **Cost is the user's job** via the agent's own clear/compact in the terminal. No context meter.
   The review's memory is the thread store, so a cleared companion re-reads it via `list_threads`.
10. **Desktop layout:** queue stays in the sidebar's Screen PRs section; room in the main area;
    outline on the right (drawer below 1200px). Phone keeps today's flow for now.
11. **Return visits:** threads, drafts, read ticks persist; "N new commits since you last looked"
    per layer; threads on changed lines are marked outdated.
12. **`request_review` from an agent session**: fresh companion (never the author), submit goes
    back to the requesting session by default (GitHub optional), and threads get an
    **Ask author** route for intent questions.

## What exists and is reused (verified by code survey)

| Need | Existing piece |
|---|---|
| Diff rendering with inline slots | `components/diff/UnifiedDiffView.svelte` (`onLineClick`, `belowRow`, `reveal`) |
| Draft comments, persistence, posting | `shared/review-drafts.ts` ops, `main/screenprs-drafts.ts` (JSON, revisions, tombstones), `main/github/review.ts` `postReview` (anchor check via `resolveAnchor`, fold on 422, pinned `commit_id`), `ConfirmReviewModal.svelte` |
| Per-layer diff of a stacked PR | `main/github/stack-base.ts` `getReviewDiff` (own commits via `compareDiff`, falls back with warning) |
| Screening / overview / deep runs + cache | `main/screenprs.ts`, `main/pr-overview.ts`, `main/deep-review.ts`, `main/screenprs-cache.ts` (head + fingerprint keys) |
| Thread UI building blocks | `InlineThread.svelte`, `ThreadBody.svelte`, `InlineComposer.svelte` (plain Svelte, not Monaco-bound); `web/lib/diff-threads.ts` row mapping |
| Typed delivery of a user message to a session, idle-gated, confirmed by `UserPromptSubmit` | `main/thread-delivery.ts` (`requestSend` :439, OpenCode over HTTP) |
| Agent replies | `reply_to_thread` (`mcp-bridge.ts:637`, `thread-delivery.ts:326`) |
| Session spawn with provider/model/initial prompt | `sessionsStore.createAgent` (renderer mints id) → `agent:spawn`; allowlist `lib/agentModels.ts` |
| Embeddable terminal | `components/terminal/Terminal.svelte` + `lib/pty-attach.ts` (backlog replay, `pty:claim`) |
| Waiting / permission status per provider | Notification + PermissionRequest hooks → `agent-status.svelte.ts` |
| MCP tool pattern | `mcp-server/index.mjs` `registerTool` → `postToBridge` → `mcp-bridge.ts handleToolCall`, caller = `terminalId` |

## What does not exist (and why the threads need their own model)

Today's agent threads are **owned by a session and rooted in a worktree**: `assertKnownWorktree`
(`agent-threads-store.ts:139`), absolute paths in `formatThreadForAgent`
(`shared/agent-threads.ts:222`), deletion when the session ends (`index.ts:1180`), a 5-unanswered
cap per session, and `parseAnchor` accepts only `file` / one commit. A review thread must outlive
any agent, anchor to a PR head, and exist with no session at all (screening findings, GitHub
comments). Bending `AgentThread` to that touches every invariant above.

**Decision: a separate `ReviewThread` model owned by a `Review`, sharing UI components and the
delivery core with agent threads, not the store.**

## Architecture

### 1. Data model (main-owned, SQLite, new migration in `main/db.ts`)

```
Review        { id, repo, layers: PrRef[] (bottom→top), requesterSessionId?, companionSessionId?,
                companionAgent: {provider, model}, readSteps: string[], lastSeenHead: {pr→sha},
                createdAt, updatedAt }
PrRef         { url, number, headSha }

ReviewThread  { id ('rt_…'), reviewId, anchor, origin, status: 'open'|'done', outdated: boolean,
                messages: ReviewMessage[], draftCommentId?: string }
anchor  =  { kind: 'stack' }
         | { kind: 'pr', pr }
         | { kind: 'line', pr, headSha, path, side: 'LEFT'|'RIGHT', startLine, endLine, snippet }
origin  =  { kind: 'finding', source: 'triage'|'overview'|'deep', key, severity?, lens? }
         | { kind: 'github', threadNodeId, rootCommentId, author, isResolved }
         | { kind: 'user' }
ReviewMessage { seq, author: 'user'|'companion'|'author'|'reviewer'|'tool', body,
                readFiles?: string[], delivery?: DeliveryState }
```

- **The draft stays in the existing draft store.** A thread's draft is a `PrReviewComment` with a
  new `threadId` field (and `inReplyTo?: rootCommentId` for replies). The posting pipeline,
  anchor resolution and folding are untouched; the thread just points at its comment. Stack
  threads set the draft's PR from the layer picker.
- **Severity** moves onto `PrReviewComment` (`severity?: 'blocking'|'consider'|'nit'`), rendered as
  a conventional-comment prefix when posted (e.g. `**blocking:**`), because GitHub has no field.
- **Stable finding keys.** Findings have no ids today (UI keys on `file+title`). Key =
  `hash(source, prUrl, file, normalizedLine, title)`; threads are materialised from run results
  for the current head and matched by key on re-run, so conversations and drafts survive a re-run.
  Triage labels map to severity (`issue`→consider, `nit`→nit, …); deep `blocking|concern|note`
  → `blocking|consider|nit`.
- IPC channels are shared with the phone (`shared/ipc-types.ts:559-670`), so every new
  `review:*` payload is validated as untrusted (same parse-function pattern as
  `parseDraftOpRequest`), even though the phone UI is out of scope here.

### 2. Stacks

`groupStacks` (`shared/screenprs.ts:635`) works per bucket, so a stack can be split across
buckets. Add `resolveStack(card, allCards)` that walks `baseRefName`/`headRefName` across all
cards, and falls back to `gh pr list --head <base>` for a parent that is not in the queue (e.g.
already approved). Each layer's diff comes from `getReviewDiff`; its isolation warning is shown
on the layer.

### 3. GitHub comments (read-only import + reply drafts)

New `main/github/review-threads.ts`: GraphQL `pullRequest.reviewThreads` (isResolved,
isOutdated, path, line, originalLine, diffSide, comments{id, databaseId, author, body}) per layer,
cached by head SHA, refreshed with the PR. Imported as `origin: github` threads (author messages =
`reviewer`). *Draft reply* creates a draft comment with `inReplyTo`. Posting replies: the REST
create-review payload has no `in_reply_to`, so replies are sent after the review with
`POST /pulls/{n}/comments/{id}/replies`. Resolving GitHub threads is out of scope.

### 4. Overview becomes the tour

The overview output contract (the fixed part since #183) gains a structured **reading order**:
ordered sections `{title, summary, refs: [{path, startLine, endLine}]}` per layer, plus a stack
section when asked for the whole stack. The room renders sections as the tour with the referenced
hunks inline; without an overview, layers show files in path order. Look-into items with refs
become `origin: finding, source: overview` threads. The overview fingerprint changes, which
invalidates cached overviews once (acceptable).

### 5. Companion

- **Session kind:** add `owner?: {kind: 'review', reviewId}` to `Session` and `SerializedSession`.
  Owned sessions are excluded from the sidebar list, the "finished unseen" dot and `visitedIds`,
  and `createAgent` gets `{select: false}`. They **stay in `_sessions`** so agent-bus peer sync
  and status tracking keep working (hiding them from `_sessions` would drop their mail).
- **Launch:** lazily on the first Ask (or the first message typed in the dock). Provider/model
  from the review's `companionAgent` (default: new setting `review.companionModel`, chosen from
  the existing allowlist). Initial prompt = a stack-aware review brief (extend
  `shared/pr-brief.ts`): layers, how to read diffs (`gh pr diff`), the thread protocol
  (`list_threads`, `reply_to_thread`, one answer per thread), "do not modify files, do not post",
  ends with "wait for my instructions".
- **Working copy:** a detached worktree at the top layer's head (`git fetch origin
  pull/<n>/head` + `git worktree add --detach`), new helper in `main/worktree.ts` (the #189 idea),
  removed when the review is submitted or discarded. Read-only is enforced per provider where
  possible (Codex `--sandbox read-only`; Claude via `--permission-mode plan` or a settings deny
  list for Edit/Write; OpenCode via the existing ruleset pattern from `agent-tasks/runner.ts:415`)
  and otherwise stated in the brief. See open question Q1 on the prototype's explicit
  "escalate to checkout" step.
- **Dock:** `Terminal.svelte` mounted in the room's bottom dock. The Screen PRs view unmounts the
  workspace terminals (`App.svelte:269`), and owned sessions never appear in the sidebar, so this
  is the only mount; the dock claims the PTY on expand. Status from `agent-status.svelte.ts`;
  `waiting` → "needs you".
- **Questions → companion:** generalise the delivery core of `thread-delivery.ts` (idle gate,
  typed submit, `UserPromptSubmit` confirmation by header) so it delivers either an agent thread
  or a review thread. Review-thread prompts carry `[Review thread rt_…]` plus the anchor
  (`#184 src/main/github/stack-base.ts:131 (RIGHT)`), the item text and the question.
- **Answers:** `reply_to_thread` dispatches on the id prefix (`t_` agent thread, `rt_` review
  thread) and checks the caller is that review's companion or requester. The existing Stop-hook
  fallback (`last_assistant_message`) applies to review threads too.
- **Redraft:** a typed request "draft my comment for rt_… from our conversation"; the companion
  answers with a new MCP tool `propose_draft(thread_id, text, severity?)`, which stores a
  *proposal* on the thread. The user accepts or keeps their text. The companion has no tool that
  writes a draft.
- **Switching agent:** stop the old companion, clear `companionSessionId`, next Ask starts the new
  one. Threads are untouched.

### 6. MCP tools (all in `mcp-server/index.mjs` + `mcp-bridge.ts`)

| Tool | Caller | Behaviour |
|---|---|---|
| `list_threads(status?, review_id?)` | any session | Agent threads of the caller **plus** review threads of reviews where the caller is companion or requester. Read-only; reading does not change delivery state. |
| `reply_to_thread(thread_id, body)` | existing, extended | Dispatch by prefix; review threads append `companion` or `author` messages depending on the caller's role. |
| `propose_draft(thread_id, text, severity?)` | companion only | Stores a draft proposal; never writes the draft. |
| `request_review(pr, focus?)` | any session | Resolves the stack for `pr` (number in the caller's repo, or URL), creates or reuses the open Review for that stack, records the caller as requester, and lists it under a **Requested** group at the top of the Screen PRs queue with the section's attention badge. It does **not** switch the view (an agent never steals the user's view, CLAUDE.md "Layout"). Returns `{review_id}` immediately. |
| `get_review(review_id)` | requester | Returns the submitted review: per-layer verdict and every posted/handed-back comment with PR, path, line, severity, text. |

Requested reviews live in main (they are `Review` rows with a requester), so the queue renders
them from the review store on every client; no per-workspace listener is involved (the existing
`show_panel`/`show_diff`/`open_worktree` consumers live in `SessionWorkspace.svelte` and do nothing
while Screen PRs is showing). A requested PR may not be in the screened queue (filter, cutoff, or
the user isn't a requested reviewer of their own agent's PR), so main fetches its card on demand
(new `screenprs:open-pr`, same card shape and review diff as screening).

### 7. Hand-back and Ask author

- **Submit dialog** (replaces `ReviewComposer`/`ConfirmReviewModal` on desktop; reuses its
  anchor-check and fold-reason display): one block per layer with verdict, drafts and fold
  warnings. With a requester: destination toggle *Send to <session label>* (default on) and
  *Also post to GitHub* (default off). Without a requester: GitHub only.
- **Hand-back delivery:** a typed prompt through the generalised delivery core (user-submitted
  semantics, not the agent bus, which caps at 8000 chars, needs a `from` session and rate-limits),
  e.g. `[Review r_… submitted] #183 approve · #184 changes requested (2 comments) · #185 comment
  (1). Call get_review("r_…") for the comments.` Short, so no size limit applies; the payload sits
  behind `get_review`.
- **Ask author:** a thread action next to Ask, only when the requester session is alive. Delivers
  `[Review thread rt_…] Question from the reviewer: …` to the requester; its `reply_to_thread`
  lands as an `author` message in the private conversation.
- **Requester gone** (closed before submit): *Send to session* disabled with a reason; GitHub and
  "copy review as markdown" remain.

### 8. Room UI (desktop)

New `components/review/`: `ReviewRoom.svelte` (shell: stack map, document, outline, bottom bars),
`StackMap`, `LayerSection` (overview/deep tools, tour or path-order diff via `UnifiedDiffView`),
`ReviewThreadCard` (item, conversation, ask row with chips, draft box, Draft/Done),
`ReviewOutline` (filters Open / To post / Done / Started by me / All, reading progress),
`CompanionDock`, `SubmitReviewsModal`. `ScreenPrsView` renders `ReviewRoom` instead of
`PrDetail` on desktop; the phone's `web/PrDetail.svelte` is untouched. *Discuss with Agent* is
removed from desktop. Return-visit banner uses `compareDiff(lastSeenHead, head)` per layer;
anchor `headSha` ≠ current head → re-resolve via `resolveAnchor`, else `outdated`.

## Delivery: 3 stacked PRs in this worktree (`gh stack`)

1. **Review model & threads** — migration, `Review`/`ReviewThread` store + ops + IPC (validated),
   finding keys + materialisation, stack resolution, GitHub review-thread import, `PrReviewComment`
   `threadId`/`severity`/`inReplyTo`, delivery-core extraction, `list_threads`, `reply_to_thread`
   dispatch, `propose_draft`. Unit tests; no UI change.
2. **Review Room UI + companion** — components above, overview reading-order contract, companion
   session ownership + launch + detached worktree + dock, submit-per-layer incl. reply posting,
   return visits, removal of desktop Discuss/old composer. Browser tests for components.
3. **`request_review`, hand-back, Ask author** — Requested group in the queue, open-by-URL, requester
   recording, submit destinations, `get_review`, Ask author.

PR 1 and 2 are coupled but large; splitting them keeps the first reviewable without UI noise.

## Verification

- Unit (vitest): finding-key stability across re-runs, anchor re-resolution/outdated, stack
  resolution across buckets, IPC parsers reject malformed payloads, `reply_to_thread` role checks,
  `list_threads` scoping, hand-back prompt formatting, severity prefixing, reply posting order.
- Browser tests (headless): thread card states, draft/proposal flow, outline filters, submit
  defaults per layer, dock collapsed/needs-you.
- E2E runs in CI only (never locally).
- Live checks before ready-for-review (by the user): a real stack on GitHub; companion on each
  provider; permission prompt in the dock; posting with a reply to an existing thread; hand-back
  into an idle Claude and an idle Codex session; return visit after a force-push.

## Docs

Fold the durable parts into `CLAUDE.md` (new "Review Room" section: model, ownership, MCP tools,
delivery rules) and delete this plan in the branch's last commit.

## Open questions

- **Q1 — explicit escalation.** The prototype starts the companion on "diff context" and offers
  *Give companion a read-only checkout*. Agents launch with a working directory anyway, and cost
  is now the user's job, so the plan always uses the detached PR-head worktree and drops the
  escalation step. Keep it dropped?
- **Q2 — reply posting.** Replies to existing GitHub threads post after the review as separate
  comments (no batching in REST). Acceptable, or do we want GraphQL pending-review replies so
  everything lands in one review?
- **Q3 — phone.** Out of scope here; the model and IPC are built for it. Confirm the phone keeps
  the old PrDetail (and its Discuss) until a follow-up.
