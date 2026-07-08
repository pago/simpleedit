# Plan: Screen PRs — fan-out triage → deep review → decide

Status: **UX settled (2026-07-07); most of it built & merged (2026-07-08)** · Worktree: `../fanout`
Reference prototype (interactive, HTML): https://claude.ai/code/artifact/a76d3a82-1c4f-4e41-b7d1-539c49abde09

## Implementation status (2026-07-08)

**Built & merged to `main`** (PRs #150 runFanout, #151 triage logic, #152 triage UI, #153 deep
review, #154 cache + resilience + Discuss + sidebar split button):
- **Triage** — `runFanout` over PRs, diff-only, local (Haiku fallback); streaming buckets, per-file
  syntax-highlighted diff (`lib/parseDiff.ts` + Monaco `colorize`), selectable in-progress cards.
- **Deep review** — lens fan-out + synthesis reduce (`deep-review.ts`, `tasks/deep-review-lenses.ts`),
  per-lens model config + Settings pane, backend concurrency gate (`agent-tasks/gate.ts`).
- **Persistent cache** (`screenprs-cache.ts`) — SHA-keyed; re-screen only re-runs changed PRs;
  ⌥-click Re-screen forces. Deep results cached per SHA.
- **Progress** — `queued`/`screening`/`triaging` events → "Triaging now / scheduled / gathering"
  phases; per-PR `timeoutMs` in `runFanout` so a wedged model can't freeze the batch.
- **Discuss with Agent** — spawns a primed Claude session (`initialPrompt` threaded through
  `claude:spawn`→`buildLaunch`); brief = PR url + findings + review-session guardrails; agent uses
  `gh` (URL-based) to inspect/checkout/post. Model via the shared **SplitButton** (`components/
  SplitButton.svelte`).
- **Settings** — Default Model pane has a Screen PRs (triage) field; Deep Review pane per-lens.

**Load-bearing gotcha (cost us a long debug):** anything passed across Electron IPC
(`window.api.invoke`) must be a **plain object** — Svelte 5 `$state` proxies throw "An object could
not be cloned". Use `$state.snapshot(...)`. Bit us on `screenprs:start` filters, `deep-start`
context, `config-set`, and the Discuss model ref.

**Operational:** qwen3.6:27b (27B reasoning) **wedged Ollama** during triage — too heavy; use Haiku
(cloud, parallel) or gpt-oss:20b for triage. The `timeoutMs` guard now bounds this.

**REMAINING (next sessions):**
1. **Review composer** — the in-app *human* path: collect line comments (from findings / diff
   clicks / own) + summary + verdict → `gh pr review --approve|--comment|--request-changes` with a
   **confirm-guard**. First thing that WRITES to GitHub. (The `gh` write wrappers go in `github/gh.ts`.)
2. Repo-aware deep-review lenses on a **checked-out worktree** (diff-only today).
3. Stacked-PR grouping (needs `headRefName` in the gh adapter/context).
4. Quick-approve ✓ on cards (one-click approve, no detail).
5. **Reuse SplitButton for the sidebar ✦ Agent button** — attempted, reverted: it regressed the
   accessible agent-view menu (e2e `agent-view-menu*` drive keyboard nav + `menuitem` roles + a
   "New Claude session" item). Redo needs SplitButton's menu to be a proper keyboard-navigable
   menu (roles + arrow/Enter) plus updating those e2e tests.

> A SimpleEdit feature adapted from the `screen-prs` Claude skill: screen the PR review
> queue and produce a ranked, streaming overview of *what to review next*, then carry a chosen
> PR through a **triage → deep review → decide** pipeline without leaving the app. It is the
> canonical **fan-out** consumer of the [bounded-tasks](./bounded-tasks.md) substrate and the
> poster child for the **local-model cost** argument ([local-models](./local-models.md)):
> cheap/local for the high-frequency screening, premium only where it earns its keep.

The whole feature reduces to **two primitives** applied three ways:
`runFanout` (fan out bounded judgments, reduce) + "spawn a primed Claude Code process on a
worktree." Triage, deep review, and discuss are all one of those two — no third mechanism.

---

## 1. Scope & thesis

Screening N PRs' diffs just to decide *what to look at* is high-frequency, low-stakes work you
should not burn premium cloud tokens on. So **triage is local + diff-only**, and premium models
are reserved for the deep pass — and even there, only for the lenses that need them. The app's
job over the CLI skill is the **workspace integration**: streaming buckets, an in-app diff, a
primed agent session, and a real path to post a review to GitHub.

---

## 2. The settled UX (the prototype is the reference)

**Entry point.** A "Screen PRs" item pinned at the **bottom of the sidebar session list**
(the sidebar is now sessions-only; the queue is org-wide, not repo-scoped, so it lives below
the list rather than in a pane or per-repo section). It shows an attention badge (count of
PRs still needing eyes).

**Layout: split view** (committed — no nav/toggle). Left = the ranked queue; right = the
detail for the selected PR.

**Streaming triage buckets.** On open (and on ↻ Re-screen) PRs stream in and slot into buckets
as each is classified — no wait-for-all:
- 🔴 **Needs your attention** — critical / high-impact / approved-but-risky
- 🟡 **Quick pass** — small, green, uncontroversial
- ⏳ **Waiting on author** — CI red; don't review yet
- ⚪ **Already approved — FYI**
Stacked PRs are grouped with dependency order ("review #645 before #648"). Green cards get a
hover **quick-approve ✓** for the trivial one-click case.

**Detail = the pipeline, made visible.** A stage rail: **Triaged → Deep review → Decide**.
- **Triage findings** (from the diff-only pass) shown first. Once a deep review is *requested*,
  the triage block **collapses** to `▸ N findings · superseded by deep review` (re-expandable),
  because deep review confirms/invalidates most of them. Deep findings are labeled authoritative.
- **Diff**: read-only `gh pr diff` by default; switches to the worktree DiffReview once checked out.
- **Actions**: `⚡ Deep review`, and `✦ Discuss` as a **split button** (see §3.3).
- **Decide**: the **review composer** (docked footer) — the human path to GitHub.

**Filters on the page**: Org (configurable, not mandatory) and Active-since cutoff. The triage
model + parallelism are **not** on the page — they live in Settings (rarely changed); a small
read-only note shows what's running and links there.

---

## 3. Architecture on the substrate

### 3.1 Triage = fan-out, diff-only, local

`gather PR list (gh) → runFanout(triageTask, prs) → deterministic bucket → stream cards`.

- **Per-PR context** is gathered in **plain JS** (`gh` calls), not by the model: size, CI,
  reviews, base branch (→ stacked detection), and the diff. Metadata is pure JSON; the model
  only reads the diff.
- **Per-PR judgment** is one `triageTask` (a `Task`, diff embedded in the prompt) run through
  **`DirectRunner` + a cheap local model**. It emits `{findings[], impact}`.
- **Bucketing is deterministic code** (a reduce over results; the skill's rules): CI-failing →
  waiting-on-author; approved-by-other → top-if-critical else FYI; unapproved → by size/CI/
  staleness. Verdict is *derived*, not model-assigned — keeps the local model's job tiny and the
  ranking reproducible, and lets the renderer re-sort live as cards land.

### 3.2 Deep review = lens fan-out + synthesis reduce

**Structurally identical to triage** — `runFanout` + a reduce — but it fans out over **review
lenses** (not PRs), and the reduce is a **synthesis Task** (an LLM pass), not deterministic code.

Each lens is a bounded `Task` with its own prompt, model, and runner. **Default is mostly local**
so a run-of-the-mill PR never spawns a fleet of premium subagents:

| Lens | Needs repo? | Runner | Default model |
|---|---|---|---|
| Intent vs. implementation | no (diff + PR body) | DirectRunner | local |
| Test coverage | no (diff) | DirectRunner | local |
| Soundness / bugs | benefits | ClaudeCodeRunner | cloud (highest stakes) |
| Type safety | yes (callers) | ClaudeCodeRunner / LSP | local *or* off — see note |
| Architecture / design | yes | ClaudeCodeRunner | cloud, **off by default** |
| **Synthesis / noise-kill** | no | DirectRunner | local |

- Every lens is **per-lens configurable in Settings** and individually toggleable. A routine PR
  runs the local lenses only; flag a risky PR → enable the cloud lenses.
- **Runner follows the lens**: diff-only lenses → `DirectRunner` (local, diff in prompt);
  repo-aware lenses → `ClaudeCodeRunner` on the checked-out worktree (real file/LSP access).
- **Synthesis / noise-kill**: a `runTask` reduce on a **local** model — takes the union of lens
  findings + the diff and drops findings the diff doesn't support, merges duplicates across
  lenses, groups by file/severity, and ranks. This is the *cheap* noise control, good enough for
  normal PRs.
- **Type-lens note**: SimpleEdit already has LSP. A cheap/deterministic "types" signal can come
  from **LSP diagnostics on the worktree** rather than a model — consider that instead of (or
  before) a model lens.

**Escalation (the expensive noise control).** For complex/dangerous PRs, the full multi-agent
skill is the **explicit escape hatch**: `Discuss → /deep-pr-review` spawns a Claude Code session
that runs the skill (adversarial per-finding refutation by independent verifiers + orchestrator
ranking). We deliberately do **not** rebuild that in-app for the default path.

### 3.3 Discuss with Agent = a primed TUI session (no embedded chat)

SimpleEdit is terminal-first (no ACP). "Discuss" **checks out the worktree and spawns a real
Claude session in the sidebar**, primed with the review brief (triage — or deep — findings +
diff). No chat panel is embedded in the screen.

- **Priming = a review-session brief**: the agent is told this is a *review* session, the PR is
  **not ours to modify** unless the user explicitly asks, and that when the user is ready it
  should **post the comments / approve / request-changes to GitHub itself** (the user's actual
  workflow). This is why Discuss is the *primary* GitHub-write path for discussed PRs.
- **Model selection via a split button**: main click starts with the remembered model; the
  caret (or right-click) opens a model menu grouped Cloud / Local. You reach for Sonnet/Opus to
  *discuss* even though triage ran local. **This split-button component is shared with the
  sidebar "✦ Agent" button** (§4.4).
- **Deep review resets a stale discuss session**: a deep review changes the brief, so clicking
  `⚡ Deep review` clears any discuss session started on the triage-only brief; re-starting
  Discuss afterward primes a fresh session with the deep findings. ("Good enough to try.")

### 3.4 Decide = review composer + the GitHub write path

Two paths to GitHub, matched to effort:
- **Composer** (docked footer, the *human* path): collects line comments (from triage/deep
  findings via `＋ review`, or your own), an overall summary, and a **verdict — Approve /
  Comment / Request changes** → `gh pr review …`. Also the home of the standalone Approve.
- **Agent session** (the *discussed* path): the primed agent posts the review itself when told.

This makes SimpleEdit a **write** client for GitHub reviews — a deliberate step past the
read-only skill. Guard posting behind a confirmation.

---

## 4. Substrate additions this feature drives

### 4.1 `runFanout` (in `agent-tasks/orchestrator.ts`)

`runFanout(task, inputs[], { runner, model, concurrency, signal })` → an `AsyncIterable` of
tagged **lifecycle events** per input — `start` / `item` / `done` / `error` (richer than the
`{input,item}` sketch, because it mirrors the single-task event model Review/Tour already emit:
status-running + findings + status-done/error, and it's what a live card/lens UI needs).
Used by **both** triage (over PRs) and deep review (over lenses).

### 4.2 Backend concurrency gate (local-serial / cloud-parallel)

Concurrency **cannot** be a per-fan-out counter, because local models are **GPU-bound** (Ollama
serializes; parallel DirectRunner calls thrash). So a slot is requested from the **backend's**
gate, not a local variable:
- **Local (Ollama / DirectRunner)** → one **global serial queue** (size 1 by default,
  user-configurable). All local bounded work — triage judgments, deep lenses, synthesis — shares
  it, no matter which fan-out spawned it.
- **Cloud (ClaudeCodeRunner)** → a separate **parallel cap**.
Speed is explicitly **not** the driver; correctness + not thrashing the GPU is. See
[bounded-tasks](./bounded-tasks.md) for where this lives.

### 4.3 GitHub adapter (`src/main/github/`)

Thin typed wrappers over the user's `gh` auth: `search prs`, `pr view --json`, `pr diff`,
`pr checks`, and (write) `pr review --approve|--comment|--request-changes` with line anchors.
The one genuinely new context source — note it as a substrate extension, not a screen-PRs hack.
Handle comes from `gh api user`; org/cutoff are on-page filters.

### 4.4 Shared split-button component

Main action + caret model menu (Cloud/Local groups, current pick checked; right-click on main
opens it too). Introduced here and **reused for the sidebar "✦ Agent" button**.

---

## 5. Model routing & config

- **Triage**: cheap local (DirectRunner), one per-PR judgment. Model + parallelism in Settings.
- **Deep review**: per-lens model, mostly local by default; soundness = cloud, architecture =
  off by default, types = LSP-or-local; synthesis = local. All in Settings.
- **Discuss**: chosen per-session via the split button (default a cloud model — you discuss on
  Sonnet/Opus).
- Reuses the existing per-feature default pattern (`getModelConfig().defaults.*`); add
  `screenPrs` (already reserved in `ModelFeatureKey`) and a deep-review lens map.

---

## 6. Build order (target: one PR; flag if it must split)

1. **`runFanout`** + backend concurrency gate + unit tests (pure substrate, no GitHub).
2. **GitHub adapter** (`gh` read + write wrappers).
3. **`triage-task.ts`** (diff-only per-PR, verdict schema) + deterministic bucketing (shared so
   the renderer re-sorts live).
4. **Deep review**: lens registry + per-lens `Task`s + the synthesis reduce task; lens→runner
   routing; per-lens model config.
5. **`screenprs.ts` orchestration + `screenprs:*` IPC** (per-window streaming, cancel).
6. **Renderer**: split-view panel (streaming buckets, stacked grouping, cards), PR detail
   (stage rail, collapsing triage, diff, deep-review section), **review composer**, the shared
   **split button**, Discuss = primed sidebar session, checkout + Review-handoff.
7. **Settings**: triage model + parallelism, per-lens deep-review model map.

The triage + panel + discuss + composer is one coherent PR. The **multi-lens deep-review engine**
(step 4) is the piece most likely to justify its own follow-up PR if step 6 grows large — decide
when the code is real, per the "fewer, larger, coherent PRs" preference.

---

## 7. Open decisions

- **Type lens**: LSP diagnostics (deterministic, no model) vs. a model lens vs. off. Lean LSP.
- **Deep-review defaults**: confirm soundness=cloud, architecture=off, types=LSP once tried.
- **Composer vs. agent posting**: both post to GitHub; the human uses the composer, the discussed
  path lets the agent post. Fine as two paths — just confirm the confirmation-guard UX.
- **Provider**: GitHub only (via `gh`) for now.

## 8. Non-goals

- Rebuilding the full adversarial multi-agent `/deep-pr-review` in-app — that's the escape hatch.
- Being the deep-review tool of record for *every* PR — triage decides *what* deserves depth.
- Merging PRs. (Reviewing/commenting/approving is in scope; merging is not.)
