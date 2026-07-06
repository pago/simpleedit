# Plan: Agents in SimpleEdit — overview & map

Status: draft (ideation in progress) · Branch: `feat/local-review` · Worktree: `../local-review`

> Index / connective-tissue doc. It holds the shared framing and links the feature plans.
> Each linked plan is independently actionable; this doc is where we keep "how the parts
> fit together." Design detail lives in the sub-plans, not here.

## Motivation

Run local (and alternate) agents inside SimpleEdit — ideally as capable as Claude Code for
coding — **without replicating a full agent harness and tool suite ourselves**. The
near-term wins are (a) letting the interactive agent run against a local model, and (b)
using a local/cheap model for the bounded, structured features (Review, Tour, screen-PRs).

**The driver is cost.** Burning premium cloud tokens on high-frequency, low-stakes work
("what should I review next?", a five-line review, minor edits) is wasteful — cheap/local
models for that, premium cloud for the hard problems. Privacy is a secondary benefit, not the
motivation.

## The three axes (framing)

"Run local agents" is not one decision but three orthogonal ones:

1. **Harness** — who runs the agentic loop and owns the tools: Claude Code vs OpenCode vs
   any [ACP](https://agentclientprotocol.com/)-speaking agent.
2. **Model** — Anthropic cloud vs a local model (Ollama) vs another cloud model. Swappable
   **within** Claude Code for free (Claude Code honors `ANTHROPIC_BASE_URL`), independent
   of the harness.
3. **UI ownership** — embed the agent's own TUI (today) vs render the
   conversation/tool-calls/permissions ourselves (what ACP would require).

**Today SimpleEdit sits at:** harness = Claude Code, model = Anthropic cloud, UI = embed
the TUI. For the interactive agent we render almost no agent UI — `pty.ts`
(`spawnClaudeTerminal`) runs `claude` in `node-pty`, embeds Claude's own TUI in xterm, and
scrapes the OSC-0 window title for `idle`/`running`. The only structured paths are
Review/Tour (headless `--print --output-format stream-json`) and the MCP gen-UI bridge
(`mcp-server/index.mjs` → `mcp-bridge.ts`), which lets the agent *push* UI into SimpleEdit.

## The two model roles

A model plays one of two roles, with opposite constraints:

- **Agent (harness gathers context).** We give the model read tools; it decides what to
  read. Claude Code already does this — a *strong* model produces context-aware output for
  free. But it needs a strong model, exactly what local models are not, so "agentic" and
  "local" are in tension.
- **Worker (SimpleEdit gathers, model judges).** SimpleEdit assembles the relevant context
  deterministically (using its LSP, symbol graph, git, open editors — things a blind agent
  lacks) and hands the model a single structured pass. This removes the exploration burden,
  which is what makes a weaker/local model viable.

Review, Tour, and screen-PRs are worker-role tasks → the **bounded-tasks substrate**.
Open-ended coding is agent-role → the **interactive agent** (Claude Code today).

## The model axis is nearly free (why we start here)

Ollama exposes an Anthropic-compatible API, and Claude Code honors `ANTHROPIC_BASE_URL`, so
we can point the **existing `claude` binary** at a local model and keep the entire harness
(tools, permissions, subagents, hooks, resume/fork, MCP bridge, OSC status) intact. This is
why axis 2 is independent of axes 1/3 — and why the first concrete work is the model layer,
not a new harness. Mechanics, caveats, and the picker UX live in [local-models](./local-models.md).

## Sub-plans (the map)

| Plan | Scope | Depends on |
| --- | --- | --- |
| [local-models.md](./local-models.md) | **Model layer** (axis 2): model discovery/install, the picker UX, endpoint/default config, and the interactive new-session-menu spike that runs Claude Code against a local model. | — |
| [bounded-tasks.md](./bounded-tasks.md) | **Orchestration substrate**: Runner / Task / Orchestrator + context primitives for Review, Tour, screen-PRs. | model layer |
| [screen-prs.md](./screen-prs.md) | **PR-triage feature** (fan-out): adapts the `screen-prs` skill — rank the review queue via a cheap/local model per PR. The canonical `runFanout` consumer and the cost poster-child. Follow-up, not near-term. | bounded-tasks, model layer |
| [agent-providers.md](./agent-providers.md) | **Multi-backend via embedded TUIs** (axis 1, pragmatic): generalize the hardwired Claude integration into pluggable providers (Claude / OpenCode / Antigravity CLI), each embedded as its own TUI. Preferred over ACP; rough sketch, not scheduled. | model layer |
| [acp.md](./acp.md) | **Interactive-agent protocol** (axes 1/3): whether to become an ACP client so any agent plugs in and we own the UI. **Currently deprioritized** — ACP normalizes away the TUI's richest UX (subagents), and multi-backend is achievable by embedding each agent's own TUI instead. Revisit only for structured-integration wins. | model layer |

## How the parts fit together

- **Shared seam = model selection.** Both the interactive session (`pty.ts` spawn, inline
  env + `--model`) and the substrate's runners (`ClaudeCodeRunner` spawn env; `DirectRunner`
  HTTP) need "which model / which endpoint." The **model layer owns that once** — a small
  `src/main/models/` module (a `ModelRef` type + Ollama detection) consumed by both. Design
  it in `local-models.md`; `bounded-tasks.md` imports it.
- **Keep the substrate ACP-agnostic.** Its `Runner` interface must not leak Claude-CLI
  assumptions, so an eventual ACP decision (`acp.md`) doesn't force a substrate rewrite.
- **Multi-backend, if wanted, is cheaper via embedded TUIs than via ACP** (see
  [agent-providers.md](./agent-providers.md)). Claude Code, OpenCode, and Antigravity CLI all
  ship rich TUIs; embedding each in a PTY (as we already do Claude's) keeps full native
  richness per agent and fits the "own the workspace *around* the agent" thesis. Because our
  renderer is already a terminal, this is mostly a main-process refactor. ACP's unique addition
  over it is only structured integration (edits through the editor, native diffs/permissions) —
  not a better interactive experience — which is why it's deprioritized (see [acp.md](./acp.md)).

## Sequencing (agreed)

Aim: ship a version that answers the real question — *"can I run a model on my machine that's
good enough for meaningful work, or will it thrash?"* — before investing in the bigger features.

1. **Claude-provider extraction refactor** ([agent-providers](./agent-providers.md), build
   step 1). Pure refactor: define `AgentProvider`, move Claude's logic behind it, normalize the
   tracking sink. Also *sets up local-model v0* — the model override becomes part of the Claude
   provider's `buildLaunch` rather than a hack in `spawnClaudeTerminal`.
2. **Configuration panel** ([local-models](./local-models.md)) — model management + **hardware-
   aware recommendations** (so you can see what your machine can actually run) + per-feature
   defaults. Shared infrastructure for both consumers below.
3. **In parallel** — **local-model v0** (interactive Claude-provider session against a local
   model) and **bounded-tasks for Review/diff only** (extract `ClaudeCodeRunner`, `runTask`,
   run Review against a local model). Together these are a shippable version and the
   experiment's answer.
4. **If it proves valuable** → **screen-PRs** ([screen-prs](./screen-prs.md), needs real UI/UX +
   `runFanout`) and opening up to **other agents** ([agent-providers](./agent-providers.md)).

Resume/fork across providers is an explicit **quality-of-life** concern, not a dealbreaker:
keep Claude's logic, allow per-provider logic for OpenCode/Antigravity, or skip where the tool
doesn't support it (capability-gated).

## Findings from the local-model v0 spike (2026-07)

Empirically tested on Ollama 0.31.1 + gpt-oss:20b:
- **Interactive local via Claude Code is blocked upstream** — Ollama #13949 hangs Claude Code's
  `/v1/messages` requests (its `count_tokens` probe poisons the endpoint); restart-only
  workaround, not our bug. So v0's "Claude Code + local Ollama model" path is currently dead —
  the Claude *cloud*-model half of v0 still works, and the plumbing is reusable.
- **Local coding therefore requires a different harness** — OpenCode (works via Ollama's OpenAI
  endpoint), i.e. the [agent-providers](./agent-providers.md) path. Antigravity is a separate
  *cloud* agent (Google), not a local path — don't conflate the two.
- **Local's highest-ROI, unblocked value is bounded tasks** ([bounded-tasks](./bounded-tasks.md)
  `DirectRunner` on Ollama's native endpoint) — cheaper than a new interactive provider and
  squarely on the cost thesis. Reprioritize toward it.
- Reasoning models (gpt-oss) are slow (~30–50s even for trivial prompts) — a poor interactive
  fit regardless; better for deliberate bounded tasks.

## Shared non-goals

- Building our own agent harness or tool suite (the entire point is to avoid this).
- Replacing the Claude TUI embed for interactive coding (pending the ACP decision).
- Committing to ACP here (tracked in its own future plan).
