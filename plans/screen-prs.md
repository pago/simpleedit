# Plan: screen-PRs — PR triage as a fan-out bounded task

Status: draft (follow-up feature; not near-term) · Branch: `feat/local-review` · Worktree: `../local-review`

> A new SimpleEdit feature adapted from the `screen-prs` Claude skill: triage the review
> queue and produce a ranked overview of *what to review next*. It is the canonical **fan-out**
> consumer of the [bounded-tasks](./bounded-tasks.md) substrate (the part Review/Tour don't
> exercise) and the poster child for the **cost** argument for local models. Deferred until
> the review/diff direction has proven itself — but the architecture must support it now.

## What the skill does (source of the design)

`~/.claude/skills/screen-prs/SKILL.md`, in four steps:

1. **Fetch** — `gh search prs --review-requested=@me --state=open --draft=false --owner=<org>`
   with a rolling 30-day activity cutoff. Produces the work-list.
2. **Fan out** — one parallel sub-agent per PR. Each gathers via `gh`: size
   (additions/deletions/files), CI status, reviews + reviewer state, base branch (to detect
   **stacked** PRs), and the diff; reads the diff for concrete concerns (bugs, missing tests,
   security smells, silent failures, type regressions); returns a tight **structured report**
   (repo#num, title, url, author, base, size, CI, reviews, approved-by-other?, findings,
   impact, verdict). Read-only, capped ~200 words.
3. **Rank & bucket** (deterministic rules) — CI-failing → "waiting on author"; approved-by-
   someone-else → top if critical/high-impact else bottom FYI; unapproved → by size/CI/staleness.
4. **Overview** — buckets 🔴 Needs attention / 🟡 Quick pass / ⏳ Waiting on author / ⚪ Already
   approved-FYI, with stacked-PR grouping and a handoff to `/deep-pr-review`.

## Why it fits the substrate exactly

The shape is `gather work-list → runFanout(prTask, prs) → deterministic reduce → render`:

- **Fetch** → an orchestration pre-step producing the fan-out inputs (list of PR refs).
- **Per-PR agent** → one `Task` in `runFanout`, with the skill's report format as its `schema`.
  Each PR is an independent, bounded judgment — exactly what fan-out is for.
- **Rank & bucket** → a plain-code reduce over collected results (the rules are deterministic;
  **not** an agent). This is the barrier/synthesis after the fan-out.
- **Overview** → the render (a bucketed panel).

This validates `runFanout` — the substrate path Review/Tour (single-shot) never exercise.

## Why it's the cost poster-child

Screening 15 PRs' diffs just to decide *what to look at* is the definition of high-frequency,
low-stakes work you should not burn premium cloud tokens on. Triage is diff-level judgment,
not deep review — so the per-PR task runs on **`DirectRunner` + a cheap/local model**
([local-models](./local-models.md)), reserving the premium model for the actual deep review
the user picks afterward. This is the clearest case of "local for triage, cloud for the hard
pass."

## New capability the substrate needs: a GitHub data source

The substrate's context primitives are currently git/LSP/file-oriented (`getDiff`,
`expandWithLsp`). screen-PRs adds a **GitHub adapter** — shell out to `gh` (search, `pr view`,
`pr diff`, `pr checks`) using the user's existing `gh` auth. This is the one genuinely new
context source; note it as a substrate extension, not a screen-PRs-only hack.

## The part beyond logic: UI/UX (the SimpleEdit differentiator)

The CLI skill just prints URLs. SimpleEdit's version earns its keep by integrating with the
workspace:

- **Bucketed panel** — 🔴/🟡/⏳/⚪ sections, per-PR cards showing size / CI / reviewers / verdict
  / findings, live as fan-out results land (streaming, same event model as Review).
- **Stacked-PR grouping** — visualize dependency order ("review #645 before #648"), not a flat
  list.
- **Handoff into SimpleEdit** — clicking a PR does more than open a browser tab: check it out
  into a worktree and open its diff in the diff-review UI, and/or trigger the Review feature on
  it. This is where triage → deep-review becomes a first-class in-app flow instead of a copy-
  paste URL.
- **Config** — org/repo filter and GitHub handle (the skill hardcodes `ivx`/`pago`); activity
  cutoff; default triage model (per-feature default from the settings panel).

## Dependencies

- [bounded-tasks](./bounded-tasks.md) — `runFanout`, the `Task`/`Runner` layer, plus the new
  GitHub context adapter. **screen-PRs is the reason `runFanout` exists.**
- [local-models](./local-models.md) — the cheap/local triage model + per-feature default.

## Build order

After Review/diff on the substrate has proven the direction (per the roadmap in
[agents-overview](./agents-overview.md)). screen-PRs needs UI/UX well beyond the logic, so it
follows once the fan-out + model plumbing is real and the local-model experiment has answered
"is a local model good enough for this kind of work?".

## Open decisions

- **Per-PR context depth** — diff-only judgment (cheap, the triage default) vs. optional
  repo-aware pass (ClaudeCodeRunner) for a chosen PR. Lean: diff-only for triage.
- **Handoff mechanics** — check-out-into-worktree vs. read-only diff view vs. trigger Review;
  how deep the triage→deep-review integration goes in v1.
- **Provider/host** — GitHub only (via `gh`), or generalize to other forges later.
- **Scope defaults** — how the org/handle/filters are configured and persisted.

## Non-goals

- Merging, commenting on, or modifying PRs — read-only triage (matches the skill).
- Being the deep-review tool — this decides *what* to review; the review itself is the Review
  feature / a deep pass.
