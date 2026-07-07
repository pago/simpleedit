# Plan: Local & alternate models (the model layer)

Status: draft (ideation in progress) · Branch: `feat/local-review` · Worktree: `../local-review`

> The cross-cutting **model layer** (axis 2 in [agents-overview](./agents-overview.md)):
> discover/install models, let the user pick one, and run the **interactive** Claude Code
> agent against it. The substrate ([bounded-tasks](./bounded-tasks.md)) reuses the discovery
> + `ModelRef` pieces defined here.

## Goal

Let a user run the interactive agent against either a **Claude cloud model** (Fable / Opus /
Sonnet / Haiku) or a **local Ollama model**, chosen per-session from a picker, with a
low-friction on-ramp for installing a local model they don't have yet — all while keeping the
existing Claude Code harness and session machinery unchanged. Bounded features (Review / Tour
/ screen-PRs) get per-feature default models set in a settings panel.

## Why local models (the driver): cost, not privacy

The primary driver is **cost**, not privacy (privacy is a secondary nice-to-have). Burning
premium cloud tokens on high-frequency, low-stakes work — "what should I review next?", "here's
a five-line change, review it", minor edits — is wasteful. The economic thesis: **cheap/local
models for the high-frequency, low-stakes work; premium cloud for the hard problems.** That's
why the model axis matters and why the bounded features (Review, Tour, screen-PRs) are the
first beneficiaries.

## Why it's nearly free (mechanics)

Ollama exposes an Anthropic-compatible API; Claude Code honors `ANTHROPIC_BASE_URL`:

```
ANTHROPIC_BASE_URL=http://localhost:11434
ANTHROPIC_AUTH_TOKEN=ollama
ANTHROPIC_API_KEY=""
claude --model <local-model>
```

This swaps the *brain* while keeping the harness (tools, permissions, subagents, hooks,
resume/fork, MCP bridge, OSC status) intact, because it's still the `claude` binary.

**Caveats (model/hardware, not integration):** local models are weaker at the agentic parts
(tool-call discipline, long-horizon planning, precise edits) — fine for short-horizon work,
a real drop for heavy coding. Ollama recommends 64k+ context (serious VRAM), and there's no
prompt cache locally, so interactive throughput can be poor. Surface these as hints, don't
hide them.

## Ollama #13949 — interactive local via Claude Code (RESOLVED via env var)

**Verified 2026-07 on Ollama 0.31.1 + gpt-oss:20b.** Claude Code probes
`/v1/messages/count_tokens?beta=true`; Ollama 404s that unsupported endpoint, and the 404
poisons Ollama's `/v1/messages` handler so every subsequent request hangs indefinitely — a
session with no output ([ollama#13949](https://github.com/ollama/ollama/issues/13949),
unresolved upstream).

**Fix: set `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` on the local spawn.** It suppresses the
`count_tokens` probe, so Ollama never 404s, never poisons, and the session works. Verified: with
that single env var, `claude -p` against gpt-oss returns normally (without it, it hangs). The
Claude provider sets it in the `ollama` branch of `buildLaunch`, so **interactive local coding
via Claude Code is enabled** and local models are back in the interactive picker.

Consequences:
- **Interactive local runs on Claude Code's (good) harness** — no proxy, no upstream wait; the
  flag is our fix and is inert once Ollama patches #13949.
- The **OpenCode provider is now optional** for local-interactive (Claude Code covers it) — it
  remains valuable for backend diversity, not a requirement. Antigravity stays cloud-only.
- **Local bounded tasks** still run via `DirectRunner` on Ollama's native endpoint
  ([bounded-tasks](./bounded-tasks.md)) — that path never touched the Anthropic endpoint.
- Caveat: Claude Code can't pass `num_ctx` over Ollama's Anthropic endpoint, so an interactive
  local session runs at Ollama's default context for the model (raise it via
  `OLLAMA_CONTEXT_LENGTH` / a Modelfile if the harness's large prompt truncates). Quality and
  speed remain model-dependent.

## Model discovery & install

Two sources, composed — live truth for what's installed, a curated on-ramp for what isn't.

- **Installed & usable** — `GET /api/tags` lists installed models (name, size,
  `details.parameter_size`, quantization). Refine with `POST /api/show`, whose
  `capabilities` array reports `tools`/`vision`/`thinking`. **Filter to `capabilities`
  includes `"tools"`** — the harness is useless with a model that can't tool-call, and users
  often have non-tool models installed (embeddings, tiny models).
- **Recommended, not-yet-installed** — a small **curated allowlist config** of coding-suited
  models (selection criteria: tool-calling capable, coding-tuned, runnable at ~64k context
  on typical dev hardware). Needed because a first-run user has an empty `/api/tags`, and
  because there is **no local API to browse the remote library** — it can't be enumerated
  live. Keep the specific model names in config, not code, and revisit as the field moves.
- **Install on demand** — `POST /api/pull {name}` streams NDJSON progress
  (`status`/`digest`/`total`/`completed`, resumable, shared across concurrent pulls) → a real
  progress bar. Triggered when the user picks a recommended model that isn't installed.

**Hardware-aware recommendations.** What's worth showing depends heavily on the machine — an
M4/32GB runs meaningfully larger models than an M1/8GB. Detect hardware (RAM via
`os.totalmem()`; chip via `sysctl` on macOS) and annotate each curated model with an approximate
**min-RAM** need (params × bytes-per-param-at-quant + context overhead — e.g. 7B-Q4 ≈ 4–5 GB,
32B-Q4 ≈ 20 GB). Then mark models that **fit / are marginal / are too big** for this machine,
sort by fit, and steer first-run users toward something that will actually run. This directly
answers the experiment's core question — "what can I even run here?" — instead of letting them
pull a model that thrashes.

Detection prerequisites: `GET /api/version` (or a failed `/api/tags`) tells us whether Ollama
is running at all — gate the whole "local" UI on it.

## Scope (decided — opinionated)

SimpleEdit is opinionated, so we keep this narrow:

- **Providers = `anthropic` (cloud Claude) + `ollama` (local) only.** No general
  "any Anthropic-compatible endpoint", no remote Ollama, no proxies/other providers. This
  kills the `{ endpoints[] }` abstraction — a two-value provider enum is enough.
- **Interactive model choice is per-session**, chosen at spawn. No global "current model".
- **Bounded-task model choice is a per-feature default** (Review / Tour / screen-PRs), set in
  the settings panel — not per-run.

### Claude cloud models are in scope too (nearly free)

The picker also lets the user choose a **Claude cloud model** (Fable / Opus / Sonnet /
Haiku). It's the same `--model <alias>` plumbing as local, just **without** the
`ANTHROPIC_BASE_URL` env override (normal cloud auth). One picker, two providers — makes the
whole thing feel intentional rather than a local-model bolt-on. (Verify the exact
alias/id strings against the installed CLI version; keep them in the same config list.)

## The picker — two surfaces

**Quick submenu (off the `✦` new-session button)** — the fast path. Lists only the user's
**curated, ready-to-use** models: their chosen Claude cloud models + their chosen installed
Ollama models. Selecting one spawns a session against it. No install actions, no clutter —
just "start a session with model X". Which models appear here is curated in settings (below).

**Settings panel** — the management surface:
- **Per-feature defaults** — pick the model for Review, Tour, and screen-PRs.
- **Submenu curation** — choose which available models appear in the quick `✦` submenu.
- **Model management** — list installed Ollama models (`tags ∩ show-has-tools`), show a
  curated **recommended** set that isn't installed, and **Install** on demand via
  `POST /api/pull` with a progress bar. Show param-size / quantization hints and a soft
  warning when context/VRAM looks marginal.

The whole "local" UI (submenu entry + Ollama section of settings) is gated on Ollama being
reachable (`GET /api/version`); the Claude cloud models are always available.

**Persistence** — remember last-used per session kind; per-feature defaults persist in settings.

## Shared module: `ModelRef` + detection

`src/main/models/` (new), the "shared seam" from the overview — consumed by **both** the
interactive spawn (below) and the substrate's runners. Contents:

```ts
type ModelRef =
  | { provider: 'anthropic'; model: string }                 // cloud Claude — no env override
  | { provider: 'ollama'; model: string; endpoint?: string } // local — sets ANTHROPIC_BASE_URL
                                                              // endpoint defaults to localhost:11434
```

Plus: Ollama detection (`/api/version`, `/api/tags`, `/api/show`), pull-with-progress
(`/api/pull`), the static Claude cloud model list, and the curated Ollama recommendation
list. Only these two providers exist by design (see Scope).

## Interactive spike: a "Local model" new-session entry

The first shippable slice. A new item in the `✦` menu spawns the existing `claude` binary
pointed at a local model. Stays `kind: 'claude'` — same TUI, same everything. Because it's
still `claude`, **session-id pinning, MCP bridge, hooks/cwd-tracking, OSC status, resume, and
fork all keep working untouched.**

### Touch-points (mirrors the existing `resumeSessionId` pattern)

1. **UI** — `src/renderer/components/sidebar/SessionList.svelte`: add
   `{ id: 'new-local', label: 'New local model session' }` to `newMenuItems`; a `startLocal()`
   opens the picker, then calls `createClaude(root, wt.path, { model })`.
2. **Store** — `src/renderer/stores/sessions.svelte.ts`: `createClaude` gains
   `opts.model?: ModelRef`, passes it through the `claude:spawn` invoke, **and stores it on
   the `Session`** (for the label/badge and so resume/fork can re-apply it).
3. **IPC** — `src/shared/ipc-types.ts`: extend `ClaudeSpawnOptions` with the model override.
4. **Main** — `src/main/pty.ts` `spawnClaudeTerminal`: when set, prefix env **inline on the
   command string** and append `--model`.

### The gotcha: inline env, NOT the pty `env` object

The obvious injection point is `getPtyOptions`' `env` (`pty.ts` ~L202). **Do not use it.** The
spawn runs an interactive login shell (`claudeShellArgs` → `-i -l`), which sources the user's
`~/.zshrc`/`~/.zprofile` *after* the process env is set — a user who `export`s
`ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL` in their profile would clobber our pty env and
silently hit the cloud. Prefix the assignments inline on `claudeCmd` so they apply to the
`claude` invocation itself, after profile sourcing:

```ts
let claudeCmd = 'claude'
const ref = options.model
if (ref?.provider === 'ollama') {
  const endpoint = ref.endpoint ?? 'http://localhost:11434'
  claudeCmd = `ANTHROPIC_BASE_URL=${endpoint} ANTHROPIC_AUTH_TOKEN=ollama ANTHROPIC_API_KEY= claude`
}
// existing buildBridgeFlags(...) + sessionFlag appends stay identical
if (ref?.model) claudeCmd += ` --model ${ref.model}`
```

Only the `ollama` provider prefixes env; the `anthropic` provider just adds `--model` and
uses normal cloud auth. Validate `endpoint` (URL allowlist) and `model` (`[A-Za-z0-9._:-]`)
before interpolating — it lands in a shell `-c` string, so treat it as injection surface.

### Effort tiers

- **v0 (afternoon):** fixed `localhost:11434`, no `--model`, one menu item. Proves the path.
- **v1:** quick submenu of curated models (Claude cloud + installed Ollama), gate the local
  entries on Ollama being reachable, persist last-used per session kind.
- **v2:** the settings panel — per-feature defaults, submenu curation, and Ollama model
  management (list installed, install recommended via `/api/pull` with progress).

### Get-right-early

- **Resume/fork must re-apply the override.** `resumePlaceholder` and
  `spawnForkedClaudeTerminal` don't know the model; without re-passing the stored `ModelRef`
  a resumed/forked local session silently reverts to cloud. Store it on the `Session`.
- **Auth isolation is free** — per-spawn inline env never touches normal cloud sessions.

## Files (provisional)

**New**
- `src/main/models/index.ts` — `ModelRef`, Ollama detection, pull-with-progress, the static
  Claude cloud list + curated Ollama recommendations.
- IPC for detection / pull progress / installed-list in `src/shared/ipc-types.ts` (`models:*`).
- renderer quick-submenu picker + a small model-selection store.
- renderer **settings panel** (per-feature defaults, submenu curation, Ollama model
  management) + persisted settings (userData) for defaults + submenu allowlist + last-used.

**Modified**
- `src/renderer/components/sidebar/SessionList.svelte` — new menu entry + picker.
- `src/renderer/stores/sessions.svelte.ts` — `createClaude` model opt; store on `Session`.
- `src/shared/ipc-types.ts` — `ClaudeSpawnOptions.model`.
- `src/main/pty.ts` — inline env + `--model` in `spawnClaudeTerminal` (and, follow-up,
  `spawnForkedClaudeTerminal`).

## Non-goals

- A new harness or ACP (see overview / future `acp.md`).
- Managing Ollama itself (install/daemon lifecycle) — assume the user runs it; just detect.
