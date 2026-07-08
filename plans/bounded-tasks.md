# Plan: Bounded-task orchestration substrate

Status: draft (ideation in progress) · Branch: `feat/local-review` · Worktree: `../local-review`

> The substrate for **worker-role** features (Review, Tour, screen-PRs) — see the two model
> roles in [agents-overview](./agents-overview.md). Consumes the model layer from
> [local-models](./local-models.md); otherwise independent of the interactive agent.

## Goal

Review, Tour, and a new screen-PRs feature share one shape — *assemble context → call a
model → validate structured output → render/stream* — plus fan-out for screen-PRs. Three
examples is past the rule of three, so we build the shape once, provider-agnostic, so any of
them can run against cloud or local models.

## Current architecture (what we're building on)

- **Review** — `src/main/review.ts`: `child_process.spawn(claude, ['--print',
  '--output-format','stream-json','--verbose','--include-partial-messages'])`, pipes a prompt
  to stdin, parses `stream_event → content_block_delta → text_delta` + final `result` via
  `readline`, extracts NDJSON findings with `lib/json-scanner.ts` (`findJsonObjectEnd`),
  streams each over the `review:finding` IPC channel. Renderer: `stores/reviewStore.svelte.ts`
  → `components/editor/ReviewPanel.svelte`.
- **Tour** — `src/main/tour.ts`: same spawn/parse shape; emits `tour:overview`/`tour:topic`;
  caches to disk. Renderer: `stores/tourStore.svelte.ts` → `TourPanel.svelte`. Also accepts
  agent-pushed tours via `tour:from-claude`.
- **screen-prs** — does not exist in SimpleEdit yet; today it's a Claude Code skill. It's the
  fan-out example: N independent, bounded PR judgments.
- **Shared bits already present:** `lib/json-scanner.ts` (NDJSON extraction),
  `gen-ui-validate.ts` + `shared/gen-ui-catalog.ts` (schema validation), the MCP bridge
  (`mcp-bridge.ts`) for exposing SimpleEdit tools to an agent.

`review.ts` is essentially this substrate written once, inline. The plan is to extract and
generalize it.

## Design: three layers

Lives in the **main process** (`src/main/`). Keep the feature-facing IPC channels (`review:*`,
`tour:*`, a new `screenprs:*`) rather than forcing one generic channel — they carry
feature-specific payloads and stay cleaner.

### 1. Runner — provider-agnostic execution (the core)

"Reuse the harness vs. harness-free" becomes a per-call strategy, not a fork. Same interface,
two implementations:

```ts
interface Runner {
  run<Item>(req: { system: string; user: string; schema: JSONSchema; model?: ModelRef },
            opts?: { signal?: AbortSignal }): AsyncIterable<Item>
}
```

- **`ClaudeCodeRunner`** — spawns `claude --print --output-format stream-json …` (today's
  path, lifted out of `review.ts`). Full harness, so the model has real file/LSP access — good
  when the task benefits from a *strong* model exploring. Model swap via spawn env.
- **`DirectRunner`** — POSTs straight to the model API, no harness. For **local** models this
  MUST target Ollama's **native `/api/chat` or OpenAI-compat `/v1/chat/completions`** (both
  verified working) — **NOT** Ollama's Anthropic `/v1/messages` endpoint, which hangs on Claude
  Code's `count_tokens` probe (Ollama #13949, unresolved). For cloud, the Anthropic API. No
  tools, single pass, faster/cheaper — good for pure generation and local models. Uses provider
  structured-output where available; else the NDJSON-prompt + `json-scanner` approach we already
  use. Because this bypasses both Claude Code and the broken Anthropic endpoint, **local
  bounded tasks work today** (see local-models "Known blocker").

`ModelRef` comes from `src/main/models/` (defined in [local-models](./local-models.md)) — the
shared seam. Keep this interface **ACP-agnostic** so a future ACP decision doesn't force a
rewrite.

### 2. Task — the per-feature definition (thin)

```ts
interface Task<Input, Ctx, Item> {
  name: string                              // "review" | "tour" | "screen-prs"
  buildContext(input: Input): Promise<Ctx>  // task-specific; uses shared primitives
  buildPrompt(ctx: Ctx): { system: string; user: string }
  schema: JSONSchema                        // one output item; validated uniformly
}
```

Each feature shrinks to a `Task` def + its existing IPC channel + renderer store. The Review
finding schema *is* `reviewTask.schema`.

### 3. Orchestrator — single vs. fan-out

```ts
runTask(task, input, { runner, model }): AsyncIterable<Item>                       // Review, Tour
runFanout(task, inputs[], { runner, model, concurrency, signal }): AsyncIterable<FanoutEvent>  // screen-PRs
// FanoutEvent = { input, index, kind: 'start'|'item'|'done'|'error', item?, error? }
```

Fan-out is "many tasks, capped concurrency, emit each result as it lands" — the **same event
stream** as single-task streaming, so the renderer treats streaming-within-a-task and
results-across-tasks identically. The event is tagged with `kind` (start/item/done/error per
input) rather than a bare `{input,item}`, mirroring the status+findings model Review/Tour emit
— that's what a live card/lens UI needs. screen-PRs uses `runFanout` **twice**: over PRs (triage)
and over review lenses (deep review); see [screen-prs](./screen-prs.md).

**Concurrency is gated per backend, not per fan-out.** Local models are GPU-bound — Ollama
serializes and parallel `DirectRunner` calls thrash — so a slot is requested from the backend's
gate: **local = one global serial queue** (size 1 by default, user-configurable), shared by all
local bounded work regardless of which fan-out spawned it; **cloud (`ClaudeCodeRunner`) = a
separate parallel cap**. `concurrency` is thus an upper bound the backend gate further constrains.
Speed is not the driver — not thrashing the GPU is.

### 4. Shared context primitives (a toolkit, not an abstraction)

`getDiff()`, `readFiles()`, and the **LSP context-expander** for Review:

> `expandWithLsp(diff)` — for each changed hunk, pull (1) the enclosing function/class,
> (2) LSP definitions of referenced symbols not in the diff, (3) the file's imports, (4) the
> sibling test file if present.

This answers "a good review needs the surroundings, not just the diff": SimpleEdit assembles
better surroundings than a blind agent would, letting a weaker local model succeed. Assembly
*logic* stays per-task; only the primitives are shared. Optional escape hatch: seed the
context **and** expose one narrow LSP-backed read tool (via the MCP bridge) so a capable model
can still chase a thread.

## Files (provisional)

**New**
- `src/main/agent-tasks/runner.ts` — `Runner` + `ClaudeCodeRunner`, `DirectRunner`.
- `src/main/agent-tasks/orchestrator.ts` — `runTask`, `runFanout` (concurrency cap).
- `src/main/agent-tasks/context.ts` — `getDiff`, `readFiles`, `expandWithLsp`.
- `src/main/tasks/review-task.ts`, `tour-task.ts` — `Task` defs.
- screen-PRs tasks: `triage-task.ts` (diff-only per-PR) + deep-review lens tasks + a synthesis
  reduce task — see [screen-prs](./screen-prs.md) §3.2/§6 (authoritative on the breakdown).

**Modified**
- `src/main/review.ts` — reduce to a `Task` def + `review:*` wiring over the substrate.
- `src/main/tour.ts` — same, over the substrate.
- `src/shared/ipc-types.ts` — add `screenprs:*`; a shared model-selection type.
- renderer stores/panels — a screen-PRs panel (fan-out list UI); model choice per feature.

(`src/main/models/` — the `ModelRef` + Ollama detection — is defined in local-models.md.)

## Build sequence

1. **Extract `ClaudeCodeRunner`** from `review.ts` (spawn + readline + `json-scanner` + schema
   validate), with `review.ts` behavior unchanged — pure refactor, guarded by the existing
   review flow/E2E.
2. **Introduce `Task` + `runTask`**; re-express Review as `reviewTask`. Still Claude Code,
   still cloud — prove the abstraction with zero behavior change.
3. **Re-home Tour** onto the substrate (second consumer validates the shape).
4. **Wire the model layer** (`ModelRef` from local-models.md) so Review/Tour can target a
   local model.
5. **`DirectRunner`** (Ollama native/OpenAI endpoint for local — never the Anthropic path, see #13949; Anthropic cloud for cloud; no harness) as the
   "local/fast" option.
6. **LSP `expandWithLsp`** context-expander for Review (the surroundings win).
7. **`runFanout` + screen-PRs** built native on the substrate (validates the fan-out path we
   don't have yet).

## Open threads

- **screen-PRs** — now has its own plan ([screen-prs.md](./screen-prs.md)); it's the canonical
  `runFanout` consumer and adds a **GitHub context adapter** (`gh` search / `pr view` / `pr
  diff` / `pr checks`) to the context primitives. Build it after Review/diff proves the
  direction.
- **LSP expander depth.** How far `expandWithLsp` should chase (defs only? callers? transitive?).
- **Default runner per feature.** Start every feature on `ClaudeCodeRunner`; flip to
  `DirectRunner`/local per-feature once measured. (The per-feature *model* default is decided
  — set in the settings panel, see [local-models](./local-models.md); this thread is only
  about the *runner*.)
- **Naming.** "Task" for the bounded unit, to distinguish from the interactive "session".

## Non-goals

- A new agent harness or tool suite.
- Committing to ACP (kept ACP-agnostic; decided in a future `acp.md`).
