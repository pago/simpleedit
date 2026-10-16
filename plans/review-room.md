# Plan: Review Room

Status: ready to implement, revised after two adversarial reviews (rev 3) · Branch: `feat/review-room` (worktree
`wt-review-room`) · Prototype: https://claude.ai/artifact/Bk1wpDP1qvUp3J7vqceZNF (replayed stack
#183 → #185)

> Replace Screen PRs' `PrDetail` with a stack-first **Review Room**: one surface where
> screening/overview/deep-review findings, other reviewers' GitHub comments, the user's own notes
> and a **review companion** agent all meet as **threads**. Agents can ask for a review of their
> own PR with `request_review`, and the submitted review flows back to them.

## Positioning (the line we do not cross)

The value is the human reviewer's judgement, amplified. Not "run an AI review and post it".

- AI **orients** (overview, tour) and **investigates when asked** (companion, deep review). It
  never **concludes**: findings are suggestions, nothing is posted that the user did not draft or
  accept, and the companion never edits a draft.
- Nothing runs on open except what already ran (screening). Overview and deep review are buttons.
  The companion starts on the first question.

## Locked decisions (design session 2026-10-15/16)

1. **Unit = stack.** A single PR is a stack of one. Posting and verdicts stay per PR.
2. **GitHub only.** Local work is reviewed by having the agent open a (draft) PR.
3. **Thread = item + private conversation + optional draft.** Only the draft is ever posted.
   Status `open | done`; "to post" = has a draft. Per-thread controls: ask input (chips:
   fact-check, "is this real?", "right severity?", sample questions), *Draft comment / Draft
   reply*, *Done*. The companion never edits a draft; it offers *Redraft from conversation*
   (accept / keep mine).
4. **Severity lives on the draft only.** The tool's severity shows as its proposal.
5. **Whole-stack threads** post on a layer picked in the draft, default the top PR.
6. **Submit = one review per layer**, own verdict. Default: Request changes if a blocking draft
   exists, Comment if any drafts, Approve otherwise (= quick approve).
7. **One companion per review**: a real agent session (Claude / Codex / OpenCode + model; default
   in settings, per-review picker). Brief ends with "wait for my instructions". Switching agent =
   new companion that reads the threads back.
8. **Companion terminal docked, collapsed, at the bottom.** Order: post bar, companion bar
   (terminal toggle left, agent picker, status), terminal last. Replaces desktop *Discuss with
   Agent*. Permission prompts show as "needs you"; the dock never auto-expands.
9. **Cost is the user's job** (the agent's own clear/compact). No context meter. The thread store
   is the review's memory; a cleared companion re-reads it via `list_threads`.
10. **Desktop layout:** queue in the sidebar's Screen PRs section, room in the main area, outline
    on the right (drawer below 1200px).
11. **Return visits:** threads, drafts, read ticks persist; "new commits since you last looked"
    per layer; threads on changed code are marked outdated.
12. **`request_review`** from an agent session: fresh companion (never the author); submit goes
    back to the requesting session by default (GitHub optional); threads get **Ask author**.
13. **No explicit checkout step.** The companion fetches a read-only checkout itself when it
    needs one (`checkout_review_head`).
14. **Posting via GraphQL** (pending review → threads + replies → submit), unless the spike in
    PR 2 hits a blocker (see §7).
15. **Phone is in scope** (PR 4): queue → the same page, outline behind a button, no terminal.
16. **`request_review` may carry the author's briefing** (what / why / impact, reading order, open
    questions). It is shown labelled "by the author", fills the tour at once, and never replaces the
    independent overview: that stays a button and, when run, checks the briefing's claims against
    the diff.

## What exists and is reused (verified by code survey + adversarial review)

| Need | Existing piece |
|---|---|
| Diff rendering with inline slots | `components/diff/UnifiedDiffView.svelte` (`onLineClick`, `belowRow`, `reveal`) |
| Draft comments, persistence | `shared/review-drafts.ts` ops (`parseReviewComment`/`commentFields` :191), `main/screenprs-drafts.ts` (JSON, revisions, tombstones) |
| Anchor checks before posting | `shared/screenprs.ts` `resolveAnchor` :463, `commentableLines`, `anchorsForHead`; fold rules in `main/github/review.ts` |
| Per-layer (isolated) diff | `main/github/stack-base.ts` `getReviewDiff` (compare parent..head, :268) |
| Screening / overview / deep runs + cache | `main/screenprs.ts`, `main/pr-overview.ts`, `main/deep-review.ts`, `main/screenprs-cache.ts` |
| Thread UI building blocks | `InlineThread.svelte`, `ThreadBody.svelte`, `InlineComposer.svelte`; phone `web/lib/diff-threads.ts`, `MobileDiff` |
| Snippet matching under a uniqueness rule | `main/thread-reanchor.ts` |
| Typed, idle-gated, confirmed delivery | `main/thread-delivery.ts` (`requestSend` :439; OpenCode over HTTP; arm-on-confirmation) |
| Agent replies | `reply_to_thread` (`mcp-bridge.ts:637`, `thread-delivery.ts:326`) |
| Exactly-once session creation | `session-create.ts` `createSessionOnce` (requestId) |
| Embeddable terminal | `components/terminal/Terminal.svelte` + `lib/pty-attach.ts` (`pty:claim`) |
| Waiting status per provider | Notification / PermissionRequest hooks, OpenCode `session.status` → `agent-status.svelte.ts` |
| Control-character stripping | `sanitizeLabel` (`agent-bus.ts:402`) |
| MCP tool pattern | `mcp-server/index.mjs` `registerTool` → `postToBridge` → `mcp-bridge.ts handleToolCall`, caller = `terminalId` |

## Why review threads get their own model

Agent threads are **owned by a session and rooted in a worktree**: `assertKnownWorktree`
(`agent-threads-store.ts:139`), absolute paths in `formatThreadForAgent`
(`shared/agent-threads.ts:222`), deletion when the session ends (`index.ts:1180`), a 5-unanswered
cap (`thread-delivery.ts:63`), `parseAnchor` accepting only `file` / one commit. A review thread
must outlive any agent, anchor to a PR head, and exist with no session (findings, GitHub comments).

**Decision: `ReviewThread` owned by a `Review`; shares UI components and the delivery core with
agent threads, not the store.** Review threads are exempt from the 5-unanswered cap (that cap
limits agent-*opened* threads; review threads are opened by the user or by tools).

## Architecture

### 1. Data model (main-owned, SQLite via `db.ts`, append-only migration)

```
Review        { id, repo, layers: PrRef[] (bottom→top), status: 'open'|'submitted'|'discarded',
                requesterSessionId?, requesterWindowId?,
                companion?: { sessionId, windowId, agent: {provider, model}, claimRequestId },
                companionAgent: {provider, model},            // picker value, survives companion end
                lastSeenHead: {prUrl → sha}, readSteps: string[],
                authorBriefing?: { stack?: {summary}, layers: {prUrl → Briefing} },
                submissions: Submission[], createdAt, updatedAt }
PrRef         { url, number, headSha }
Briefing      { what, why, impact, readingOrder: {title, summary, refs: {path, startLine, endLine}[]}[],
                openQuestions: {path?, line?, text}[], forHead: sha }
Submission    { at, destination: {session: boolean, github: boolean},
                layers: { prUrl, verdict, reviewNodeId?, postedCommentIds: string[],
                          state: 'pending'|'posted'|'failed'|'unknown' }[] }

ReviewThread  { id ('rt_…'), reviewId, anchor, origin, status: 'open'|'done', outdated: boolean,
                readSeq: number, askAuthorOpen: boolean,
                messages: ReviewMessage[], draftCommentId?, proposal?: {text, severity?} }
anchor  =  { kind: 'stack' } | { kind: 'pr', pr }
         | { kind: 'line', pr, headSha, path, side: 'LEFT'|'RIGHT', startLine, endLine,
             snippet, before, after }
origin  =  { kind: 'finding', source: 'triage'|'overview'|'deep'|'author', key, severity?, lens? }
         | { kind: 'github', threadNodeId, rootCommentId, author, isResolved }
         | { kind: 'user' }
ReviewMessage { seq, author: 'user'|'companion'|'author'|'reviewer'|'tool', body,
                readFiles?: string[], delivery?: DeliveryState }
```

- **Ops, validated, broadcast** — the review-drafts / agent-threads pattern: client ops
  (`shared/review-room.ts`, `parseReviewOp`), rev + tombstones, `review:changed` broadcast to
  every window and phone. What only main may do (companion claim, agent messages, delivery
  states, submissions, materialisation) is a main function, never an op. Every `review:*` payload
  is parsed as untrusted (the phone is a remote client).
- **The draft stays in the draft store, and `draft.threadId` is the source of truth** for the
  link (`ReviewThread.draftCommentId` is derived on read, never stored, so SQLite and the JSON
  draft file can't disagree). Deleting the draft unlinks the thread; deleting a thread removes its
  draft. A whole-stack thread's draft lives in the picked layer's draft; changing the layer is one
  main function that adds to the new layer's draft, then removes from the old (a crash between
  leaves two copies, never none; the next load drops the older one by `threadId`). A thread's draft is a `PrReviewComment` with new fields
  `threadId`, `severity?: 'blocking'|'consider'|'nit'`, `inReplyTo?: {threadNodeId, rootCommentId}`.
  `commentFields` / `parseReviewComment` (`review-drafts.ts:191`) are extended so the fields
  survive validation. Posting changes are listed in §7; nothing about posting is "untouched".
- **Findings → threads (materialisation).** On each run result for a layer's current head, main
  matches findings to existing finding threads of the same source by **file + snippet** around the
  cited line, with `thread-reanchor.ts`'s uniqueness rule (title similarity only breaks ties). A
  match updates the item text; an unmatched new finding creates a thread; a thread whose finding
  disappeared is **never deleted if it has a conversation, a draft or a proposal**: it is marked
  outdated ("no longer reported"). Untouched ones are removed. Triage labels map to severity
  (`issue`→consider, `nit`→nit, `suggestion`→nit, …); deep `blocking|concern|note` →
  `blocking|consider|nit`.

### 2. Stacks

`groupStacks` (`shared/screenprs.ts:635`) is per bucket, so it splits stacks. New
`resolveStack(card, allCards)` walks `baseRefName`/`headRefName` across all cards and falls back to
`gh pr list --head <base> --state all` for parents outside the queue (merged/closed included).
Each layer's diff is `getReviewDiff`; its isolation warning shows on the layer.

### 3. GitHub comments (read-only import + reply drafts)

New `main/github/review-threads.ts`: GraphQL `pullRequest.reviewThreads` (isResolved, isOutdated,
path, line, originalLine, diffSide, comments{id, databaseId, author, body}), **paginated** (threads
and comments, `first: 100` + cursors), per layer, cached by head SHA. GitHub's coordinates refer to
GitHub's whole-stack diff, so each thread is **mapped through `commentableLines` of the review
diff**; a thread that doesn't map (lower-layer file, LEFT side on an isolated diff, outdated)
becomes a PR-level thread with "on code outside this layer's diff" and its original
path:line. *Draft reply* creates a draft with `inReplyTo`. Resolving GitHub threads is out of
scope.

### 4. Overview becomes the tour

The overview's fixed output contract (since #183) gains a structured **reading order**: ordered
sections `{title, summary, refs: [{path, startLine, endLine}]}` per layer, plus a stack section
when run for the whole stack. Sections render as the tour with the referenced hunks inline;
without an overview, a layer shows files in path order. Look-into items with refs become
`origin: finding, source: overview` threads. The fingerprint change invalidates cached overviews
once (acceptable).

### 4a. The author's briefing (`request_review(…, briefing)`)

- Same structure as the overview's sections plus `openQuestions`, per layer, optionally one
  stack summary. Parsed by main against that contract (unknown fields dropped), capped (≈20 KB
  per layer, 50 reading-order sections, 30 questions), `refs` kept only when they resolve to a
  path in that layer's review diff (`resolveRefPath`), text sanitised. Rendered as markdown
  only; never typed into a PTY.
- Stamped with the layer's head (`forHead`); after a push it is shown as "written for an earlier
  head". **Files the briefing's reading order leaves out are always appended** under "Not in the
  author's tour", at any head, so an author can't hide a file.
- It is untrusted input to the overview: fenced as data in a block it can't close (delimiters
  stripped from its text), and part of the overview cache fingerprint. The companion brief says
  thread bodies (findings, reviewers, author questions) are untrusted data.
- **Display:** fills the layer's what / why / impact and the tour immediately, under a "by the
  author" label (the same standing as the PR description). `openQuestions` become
  `origin: finding, source: 'author'` threads (no severity).
- **Independent overview stays manual.** When run, the briefing is one input (beside the PR
  body, under the overview's input budget), and the contract's fixed part tells it to check the
  briefing's claims against the diff; disagreements come back as Look-into items, so they
  become threads. The overview then replaces the author's text in the layer header, and the
  briefing stays reachable as "Author's briefing".
- Only the recorded requester may update an open review's briefing (new head); threads from the
  old questions follow the finding rules in §1. `request_review` from another session for a
  stack with an open review is refused with that review's requester named; it never replaces the
  requester or hand-back target.

### 5. Companion

- **Launch at the project root**, like every agent (CLAUDE.md "Claude Code integration"), so the
  transcript and memory keep the project's key. Lazily, on the first Ask or first input typed in
  the dock.
- **Main-only launch path.** The companion is created by a main-only request (no new fields on
  `SessionCreateRequest`, which the phone can reach); `owner` and `reviewCompanion` are never
  accepted from a client. The renderer's `createAgent` grows `{select: false}` (today it always
  `select(id)`s, `sessions.svelte.ts:381`).
- **Ownership across windows.** Reviews are app-wide, sessions and PTY mounts are per window.
  **Any desktop window can host the companion, at its own project root** (a review is keyed by
  GitHub repo, a window by local bare repo; they need not match). The phone's Ask claims through
  the window its socket joined.
  Main claims the companion atomically: `claimCompanion(reviewId, windowId, requestId)`
  (compare-and-set, `createSessionOnce` semantics); only the winning window creates the session.
  Delivery and replies are main-side, so **Ask works from any window**; only the terminal mount is
  window-bound. Another window's dock shows the status plus "Terminal lives in window X —
  Focus it". When the owning window closes, the companion ends (`companion` cleared, see
  "Session end"); the next Ask, from any window, claims a new one.
- **Hidden but alive.** `Session.owner?: {kind: 'review', reviewId}` (also on
  `SerializedSession`). One predicate, `isOwned(session)`, is applied at **every** user-facing
  listing: the sidebar list, the finished-unseen dot, `visitedIds`, the close-fallback
  `select(next)` (`sessions.svelte.ts` ~590), `WorkspaceManager`'s empty state
  (`WorkspaceManager.svelte:33`), the command palette, ⌘-switching, **the phone snapshot**
  (`windowSessionSnapshot`, `sessions.svelte.ts:1330`, → `session:sync`) and **push**
  (`remote/push.ts:367` `waiting`). The companion's `waiting` is reported in the room instead. It stays in `_sessions` so
  agent-bus peer sync and status keep working; `list_sessions` marks it `owner: review`.
  `createAgent` gets `{select: false}`.
- **Restore.** Quit is not a session end: `review.companion` survives it, and the owner link is
  persisted on the session. A restored owned session is a `pendingResume` placeholder; the room's
  dock offers *Resume*, which re-derives the launch options (`reviewCompanion`, deny settings,
  extra dir) from `owner`. No auto-resume. At startup, owned placeholders whose review is not
  `open` are deleted.
- **Session end** (exit, kill, closing its window while the app keeps running, agent switch):
  main clears `review.companion`; every
  review-thread message `held` / `delivered`-and-armed on that session becomes `unanswered` with
  Retry (Retry goes to the next companion).
- **Brief** (extend `shared/pr-brief.ts`, stack-aware): layers with URLs and head SHAs; "read
  each layer's diff with `get_review_diff`, **not** `gh pr diff` (an upper layer's GitHub diff
  contains the whole stack)"; the thread protocol (`list_threads`, `reply_to_thread`,
  `propose_draft`, one answer per thread); "use `checkout_review_head` when you need code outside
  the diff"; "do not modify files, do not post to GitHub"; ends with "wait for my instructions".
  The requester's `focus` (agent text) is included only as a quoted, sanitised (control chars
  stripped) block capped at 2000 chars.
- **Read-only, best effort, per provider.** New `LaunchPlan` option `reviewCompanion: true` (PR
  2), mapped per provider and **verified live** per provider, including that MCP tool calls still
  work:
  - Claude: a `permissions.deny` list in the session's `--settings` file for Edit, Write,
    NotebookEdit **and Bash** (Read/Grep/Glob cover reading; diffs and threads come over MCP).
    Pattern-denying writes is not enough: `sed -i`, redirects or `gh api -f` (POST by default)
    slip through. Not `--permission-mode plan` (it
    can block MCP writes such as `reply_to_thread` and its ExitPlanMode dialog reads as
    "needs you").
  - Codex: `--sandbox read-only` is viable because the companion needs no network (diffs and
    threads come over MCP). Verify live that MCP calls **and the hook reporter**
    (`UserPromptSubmit`/`Stop` → bridge HTTP, `agents/codex.ts:35-89`) still work; if hooks are
    sandboxed, delivery never confirms, so fall back to `workspace-write` with the brief.
  - OpenCode: a companion ruleset derived from `openCodeReadOnlyEnv`
    (`agent-tasks/runner.ts:443-458`), which denies `bash` and `external_directory`; the companion
    variant allows `external_directory` for the review's checkout dir only.
  - Where a provider can't enforce it, the brief states it and the UI says "read-only by
    instruction" in the companion bar's tooltip. The plan does not claim enforcement it can't
    deliver.
- **Checkout on demand** (`checkout_review_head(review_id, pr?)`): main fetches the PR's own repo
  into a **main-owned cache** (`userData/review-repos/<owner>/<repo>.git`, partial clone
  `--filter=blob:none`, reused across reviews) and adds a detached worktree at the layer's head
  under `userData/review-checkouts/<reviewId>/<pr>`. Paths include the host
  (`review-repos/<host>/<owner>/<repo>.git`), and owner/repo are validated with the existing
  owner rule (`parseScreeningFilters`) since they come from agent-supplied URLs. Fetches use
  `gh auth git-credential`, take `refs/pull/<n>/head` from the base repo (works for fork PRs),
  and run under a per-repo mutex. The cache is an LRU with a size cap (default 5 GB); checkouts of
  reviews untouched for 14 days are removed, and reviews whose PRs are all merged/closed are
  auto-closed (`discarded` if never submitted). It never touches the user's bare repos, so no
  worktree watcher or picker sees it, and it works for PRs from repos no window has open. Returns
  the absolute path; the brief tells the agent to read files there by absolute path. Access is
  granted at launch, not later: the review's checkout dir is created (empty) before the companion
  starts and passed as an extra directory (Claude `--add-dir`; Codex's read-only sandbox reads
  everywhere; OpenCode verified live), so a later checkout needs no relaunch and raises no
  permission prompt. Removed on submit or discard, and swept at app start for reviews no longer
  open.
- **Dock.** `Terminal.svelte` in the room's bottom dock of the owning window; the Screen PRs view
  unmounts workspace terminals (`App.svelte:269`) and owned sessions never appear in Sessions, so
  it is the only mount; it claims the PTY on expand. `waiting` → "needs you", per provider.
- **Questions → companion.** The delivery core of `thread-delivery.ts` (idle gate, draft rule,
  typed submit, `UserPromptSubmit` header confirmation, arm-on-confirmation, Stop fallback) is
  extracted so it serves agent threads and review threads alike, with **one per-session state**
  (held, batch, armed) over both stores: `requestSendNow` today reads only the agent-thread store
  (`thread-delivery.ts:443-445`), and two cores would type into the same PTY. A review-thread prompt carries
  only **system-composed text plus the user's own question**:
  `[Review thread rt_… · #184 src/main/github/stack-base.ts:131 RIGHT] <user's question>`. Item
  bodies (findings, other reviewers' comments) are **not** typed into the PTY; the companion reads
  them with `list_threads` as tool data.
- **Answers.** `reply_to_thread` dispatches by id prefix (`t_` agent thread, `rt_` review thread).
  For review threads: the companion may reply to any thread of its review; the requester only to
  threads with `askAuthorOpen`, and its reply closes that request. The Stop fallback attaches
  `last_assistant_message` only to threads armed by a confirmed delivery in that turn, so a
  requester's unrelated turn never lands in a thread.
- **Redraft.** A typed request asks the companion to call `propose_draft(thread_id, text,
  severity?)`, which stores `thread.proposal`. The user accepts (draft updated by a user op) or
  keeps theirs. No agent tool writes a draft.
- **Switching agent** = session end (above) + `companionAgent` updated; next Ask claims a new one.

### 6. MCP tools (`mcp-server/index.mjs` + `mcp-bridge.ts`)

| Tool | Caller | Behaviour |
|---|---|---|
| `list_threads(status?, review_id?)` **(new)** | any session | Caller's agent threads plus review threads of reviews where the caller is companion or requester (requester: only threads with an open Ask-author request). Read-only. |
| `reply_to_thread(thread_id, body)` (extended) | as §5 | Dispatch by prefix; role checks as §5. |
| `get_review_diff(review_id, pr)` **(new)** | companion | The layer's review diff (isolated), size-capped with a truncation note. |
| `checkout_review_head(review_id, pr?)` **(new)** | companion | §5; returns the path. |
| `propose_draft(thread_id, text, severity?)` **(new)** | companion | Stores a proposal; never writes the draft. |
| `request_review(pr, focus?, briefing?)` **(new)** | any session | Resolves the stack (number in the caller's repo, or URL), creates or reuses the **open** Review for that stack, records requester session + window, lists it under **Requested** at the top of the Screen PRs queue with the section's attention badge. Does **not** switch the view (CLAUDE.md "Layout"). Returns `{review_id}` at once. |
| `get_review(review_id)` **(new)** | requester | The latest submission: per-layer verdict, state, and every comment (PR, path, line, severity, text). |

Requested reviews are `Review` rows with a requester, so every client renders them from the
review store; no per-workspace listener is involved. A requested PR may not be in the screened
queue (filter, cutoff, not a requested reviewer), so main fetches its card on demand
(`screenprs:open-pr`, same card shape and review diff as screening).

### 7. Submit and posting

- **Dialog** (replaces `ReviewComposer` on desktop; `ConfirmReviewModal` stays for the queue's
  quick approve, `ScreenPrsQueue.svelte:9`): one block per layer with verdict, drafts, fold
  warnings. With a requester: *Send to <session>* (default on) and *Also post to GitHub* (default
  off); without: GitHub.
- **GraphQL posting** (new `main/github/review-graphql.ts`), per layer:
  1. Find or create the viewer's **pending** review on the PR (`addPullRequestReview` with
     `commitOID` = the head the user read). GitHub allows one pending review per user per PR: if
     one exists that SimpleEdit didn't create (`reviewNodeId` unknown), stop and ask (use it /
     cancel), never silently merge into it.
  2. Add line drafts as threads (`addPullRequestReviewThread`: path, line, side, start*), replies
     with `addPullRequestReviewThreadReply` **always passing `pullRequestReviewId`** (without it a
     reply posts immediately). Each added item records `{draftId, draftRev, nodeId}`. Severity is rendered as a
     conventional-comment prefix (`**blocking:**`) by the payload builder.
  3. `submitPullRequestReview(event)`.
  - **Idempotent retries:** the pending review is invisible until submit, its id is recorded in
    the submission before anything is added, and each added item is recorded as it lands. A retry
    resumes the same pending review: missing items are added, items whose draft changed since
    (`draftRev`) are updated (`updatePullRequestReviewComment`); a submitted review is never
    re-submitted. A timeout leaves `state: unknown`; the retry re-reads the pending review and
    matches items by a hidden marker (`<!-- se:<draftId> -->`) appended to each body.
    **Drafts are cleared only after `submitPullRequestReview` succeeds** (`clear-posted` with the
    landed ids), so a pending review deleted on GitHub or a failed submit loses nothing. Cancel
    and abandoned submissions call `deletePullRequestReview`, since a leftover pending review
    blocks the user's own web review.
  - **Anchor rules carry over:** the existing `resolveAnchor` / `anchorsForHead` / LEFT-on-isolated
    fold rules run before step 2; a thread GitHub rejects folds into the review body with its
    file:line and snippet, like today's 422 path. Unit tests port the REST cases.
  - **Spike first (start of PR 2):** confirm against a scratch PR that replies attach to the
    pending review, fold-on-error works per item, and `commitOID` pins as REST `commit_id` does.
    If any of these fails, fall back to REST (create review, then replies via
    `POST /pulls/{n}/comments/{id}/replies`) with the same per-item posted state.
- **The phone posts through the same main path** (`screenprs:submit-review` grows a `reviewId`),
  so it inherits all of the above; no posting logic lives in a client. Until PR 4 ships, the old
  REST `postReview` path refuses drafts that carry `threadId`/`inReplyTo` with a reason (from PR 2
  on), so the old phone screen can't turn replies into top-level comments.
- **Hand-back** (to the requester): a typed prompt through the delivery core, system-composed
  only: `[Review r_… submitted] #183 approve · #184 changes requested (2 comments) · #185 comment
  (1). Call get_review("r_…") for the comments.` Delivery is confirmed like any thread prompt; a
  failure shows on the submission with Retry.
- **Ask author**: a thread action, shown only while the requester session is alive; sets
  `askAuthorOpen`, delivers `[Review thread rt_… · question for the author] <user's question>`.
- **Requester gone:** *Send to session* disabled with the reason; GitHub and "copy review as
  markdown" remain.
- After a successful submission the review is `submitted`; the companion is ended and the
  checkout removed. A later `request_review` for the same stack opens a new review that links the
  previous one.

### 8. Return visits

- `lastSeenHead[pr]` is set when the user opens a layer, and **advances** when they submit or
  dismiss the "new commits" banner (*Got it*), never by scrolling.
- The banner uses the compare API's `status` / `ahead_by` between `lastSeenHead` and the head:
  `ahead` → "N new commits since you last looked" + *Show only the new changes* (the compare diff;
  when the base was merged in, the interdiff is computed on the review diffs, not the raw compare,
  so main's delta doesn't show); `identical` → no banner; `behind` → "the branch was reset
  to an older commit";
  `diverged` or 404 (force-push dropped the old head) → "History was rewritten since you last
  looked", no interdiff.
- Line threads whose `headSha` ≠ current head are re-resolved (`resolveAnchor` on the new review
  diff, snippet + context); unresolved → `outdated`, shown with their original lines.

### 9. Room UI (desktop)

New `components/review/`: `ReviewRoom.svelte` (stack map, document, outline, bottom bars),
`StackMap`, `LayerSection` (overview / deep-review tools, tour or path-order diff via
`UnifiedDiffView`), `ReviewThreadCard` (item, conversation, ask row + chips, draft box,
Draft/Done; reads `readSeq` while on screen like `InlineThread`), `ReviewOutline` (Open / To post /
Done / Started by me / All, reading progress), `CompanionDock`, `SubmitReviewsModal`.
`ScreenPrsView` renders `ReviewRoom` instead of `PrDetail` on desktop; desktop *Discuss with
Agent* is removed. The outline is a right column at ≥1200px and a drawer below. Settings gets a
*Review companion* default (`review.companionModel`, from the Models allowlist) in PR 2.

### 10. Phone (PR 4)

- Queue (`PrBoard`, now stack-aware via `resolveStack` and showing **Requested**) → the room as
  one scrolling page: stack map, layers, tour/diff (`MobileDiff` with `diff-threads.ts` row
  mapping), thread cards, outline behind a button, submit sheet with per-layer verdicts.
- **No terminal.** Ask works (delivery is main-side; the companion lives in a desktop window).
  If no desktop window can host a companion (none open for the project), Ask is disabled with the
  reason. The bar shows status and "needs you" (with "answer on the Mac").
- The phone's old `PrDetail` + `DiscussSheet` are replaced. Socket payloads stay small: threads
  without diffs, the diff fetched per layer (`screenprs:pr-diff`), the "unknown outcome" latch
  extended to submissions.

## Delivery: 4 stacked PRs in this worktree (`gh stack`)

1. **Model & threads** — migration; `Review`/`ReviewThread` store, ops, parsers, broadcast;
   `Session.owner` + `isOwned` + `claimCompanion` (so PR 1's role checks are real, not
   requester-only); finding materialisation; `resolveStack`; GitHub thread import + mapping;
   draft fields + parser changes; delivery-core extraction; MCP `list_threads`,
   `reply_to_thread` dispatch, `get_review_diff`, `propose_draft`. No UI change.
2. **Room UI + companion + posting** — GraphQL spike first; components; overview reading-order
   contract; companion launch, `reviewCompanion` launch option per provider,
   `checkout_review_head` + cache, dock, restore/Resume, session-end handling; submit dialog +
   GraphQL posting; return visits; removal of desktop Discuss / `ReviewComposer` (quick approve
   keeps `ConfirmReviewModal`).
3. **`request_review`, hand-back, Ask author** — Requested group, `screenprs:open-pr`, requester
   recording, author's briefing (parse, display, overview input), destinations, `get_review`,
   Ask author.
4. **Phone** — §10.

## Verification

- **Unit (vitest):** isOwned over the phone snapshot and push; companion launch options never
  accepted from `session:create`; drafts kept when submit fails or the pending review is gone;
  edited-after-add item updated on retry; reply carries `pullRequestReviewId`; marker matching
  after a timeout; layer move of a stack draft; cache path validation (traversal, host);
  briefing can't hide files and changes the overview fingerprint; `request_review` refused for
  another session's open review; one delivery state across both stores; finding matching across a push that shifts lines and an LLM re-run that
  rewords titles (no thread with a conversation/draft lost); anchor re-resolution → outdated;
  `resolveStack` across buckets incl. merged parents; GitHub thread mapping onto an isolated diff
  (LEFT, lower-layer file, outdated → PR-level); pagination; every `parseReviewOp` /
  `review:*` parser rejects malformed and oversized payloads; `claimCompanion` races;
  `reply_to_thread` role checks incl. requester on a non-Ask-author thread (refused) and an
  unrelated requester turn (not attached); `list_threads` scoping; session end → `unanswered`;
  GraphQL posting: retry after partial add, timeout → unknown → resume, pre-existing foreign
  pending review → stop, fold-on-error per item, severity prefix; hand-back formatting;
  focus sanitising/capping; briefing parse (oversized, unknown fields, refs outside the diff
  dropped, stale head); overview input includes the briefing and its contract asks for the check; compare `ahead`/`diverged`/404.
- **Browser (headless):** thread card states, draft/proposal flow, outline filters, per-layer
  verdict defaults, dock collapsed / needs-you / other-window state.
- **E2E (CI only, never locally):** open room → Ask → reply lands in the right thread (stub
  agent); submit per layer with a reply (mocked `gh`); restore with an owned companion → Resume in
  the dock, not in Sessions; two windows on one review (single companion, Ask from the second);
  `request_review` from a session lists the review without switching the view; hand-back reaches
  the requester.
- **Live (user, before ready):** a real stack; companion on Claude, Codex, OpenCode each with a
  permission prompt in the dock and read-only checks (edit refused, MCP calls work,
  `checkout_review_head` readable); GraphQL post with a reply to an existing thread; hand-back
  into idle Claude and idle Codex sessions; return visit after a force-push; phone Ask + submit.

## Docs

Fold the durable parts into `CLAUDE.md` (new "Review Room" section: model, ownership + windows,
delivery and role rules, MCP tools, posting, checkout cache) and delete this plan in the branch's
last commit.

## Open questions

None blocking. The GraphQL spike (§7) can still send posting back to REST.
