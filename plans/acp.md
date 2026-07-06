# Plan: ACP client — owning the interactive agent UI

Status: **draft — deprioritized** (see Counter-case). Branch: `feat/local-review` · Worktree: `../local-review`

> Axes 1 + 3 in [agents-overview](./agents-overview.md): become an
> [Agent Client Protocol](https://agentclientprotocol.com/) client so any ACP agent (Claude
> Code, OpenCode, Gemini, Codex, …) plugs into the interactive experience **and SimpleEdit
> renders the conversation itself**. This is a project-identity decision, so the plan is
> built to be *additive and reversible*, not a wholesale migration.

## The decision this doc exists to make

Not "should we support more agents" but **"does SimpleEdit want to own the agent UI?"**
Today we embed Claude's TUI in an xterm PTY and render almost nothing. ACP inverts that: the
client renders everything and serves the agent's file/terminal needs. Owning the UI is the
entire premise — the cost and the payoff both flow from it.

## Counter-case: why this is currently deprioritized

SimpleEdit's thesis is to own the **workspace/review layer around** the agent (worktrees,
diff review, file highlighting) and let the agent's own UI be its own. The TUI embed already
delivers a rich, always-current, vendor-maintained interactive experience for free. Against
that baseline:

- **ACP is a normalized lowest-common-denominator surface.** It carries the *data* for
  permissions, plans, modes, tool calls — but the richest, most differentiated TUI features
  are precisely the ones it doesn't model. **Subagent / agent-team UX degrades** (no
  first-class subagent concept; Claude's tmux-driving agent team especially won't survive) —
  it flattens to nested tool-call activity.
- **The bad ACP UX in existing IDEs (Zed/VS Code) is *their* design choice, not ACP's
  ceiling** — SimpleEdit could render the same events well. But even rendered perfectly, ACP
  caps you at "the normalized subset", never full TUI fidelity, and matching an evolving
  bespoke TUI through a fixed protocol is a partly-unwinnable race.
- **One thing that does *not* degrade:** decision prompts / "checkboxes" arrive as structured
  `session/request_permission` options → render as *native* widgets, arguably nicer than the
  TUI selector. This is the one interactive area ACP improves.
- **Multi-backend does not require ACP.** Claude Code, OpenCode, Gemini, Codex all ship rich
  TUIs; each can be embedded in a PTY the way Claude's is today — keeping full native richness
  per agent. So ACP's *only* unique addition over "embed-a-TUI-per-agent" is the **structured
  integration** (edits through the editor, native diffs, native permissions, protocol status
  instead of OSC-scraping) — which today's MCP gen-UI bridge + hooks already approximate.

**Conclusion:** ACP's real value is multi-backend + structural integration, *not* a better
interactive experience than the TUI. Given the thesis, that's not worth rebuilding the
conversation UI and losing subagent richness — yet. Keep the TUI embed as the interactive
surface; get multi-backend (if wanted) by embedding other agents' TUIs; revisit ACP only if
the structured-integration wins become genuinely painful, and then only as the additive
`kind:'acp'` lane below. The rest of this doc is the design for *if/when* we do it.

## What ACP is (protocol surface)

- **Transport:** JSON-RPC 2.0 (methods + notifications). The agent typically runs as a
  **subprocess of the client**; the client drives it.
- **Handshake:** `initialize` (negotiate version + exchange capabilities) → `authenticate`
  if the agent requires it. Agents advertise `promptCapabilities`, `sessionCapabilities`,
  `mcpCapabilities`, `authMethods` in the `initialize` response.
- **Sessions (client→agent):** `session/new`, `session/load` (replays history; needs
  `loadSession`), `session/resume` (resume without replay), `session/list`, `session/close`,
  `session/delete`, `session/set_mode` (e.g. ask/architect/code), `session/set_config_option`,
  `session/cancel` (notification).
- **Prompt turn:** client sends `session/prompt` → agent streams `session/update`
  notifications → turn ends with the `session/prompt` response carrying a stop reason. Client
  may `session/cancel` mid-turn.
- **`session/update` types:** agent message chunk, user message chunk, **thought**, **tool
  call**, **tool call update**, **plan**, available-commands, mode change, config change.
- **Tool call fields:** `kind`, `status` (pending / executing / completed / failed),
  `content`, `locations` (files/resources affected), `diffs` (`path` / `oldText` / `newText`).
- **Permission (agent→client):** `session/request_permission` — client surfaces a prompt and
  returns the choice.
- **Client MUST implement (agent→client):** `fs/read_text_file`, `fs/write_text_file`, and
  terminals — `terminal/create`, `terminal/output`, `terminal/wait_for_exit`,
  `terminal/kill`, `terminal/release`. Paths are absolute; line numbers 1-based. Each is
  gated behind a client capability declaration.
- **MCP:** agents accept MCP servers (`mcpCapabilities`: stdio / http / sse), so our existing
  gen-UI MCP server can still be handed to the agent.

## What SimpleEdit gains

- **Backend pluggability** — Claude Code, OpenCode, Gemini CLI, Codex, Copilot, Qwen all
  speak ACP. One client, many agents.
- **Deep native integration (the real prize).** Because the agent calls **our** `fs/*` and
  `terminal/*`, every edit flows through SimpleEdit's file layer — live in the editor, no
  hooks. Tool-call `locations` give exact touched-file data → **replaces** the hook-based
  `claude:file-touch` / cwd-tracker machinery with first-class protocol data.
- **Structured UI we own** — tool-call timeline; diffs rendered in Monaco (reuse
  `MonacoDiffEditor`); permission prompts as inline approve-with-diff-preview; plans and modes
  first-class. A differentiator over embedding a TUI.
- **MCP gen-UI bridge survives** — pass our MCP server to the ACP agent (reconcile overlap:
  native diff rendering may make `show_diff` redundant).

## What SimpleEdit must build

**Main process — new `src/main/acp/`:**
- Agent subprocess spawn + JSON-RPC 2.0 framing over stdio.
- `initialize` handshake, capability negotiation, `authenticate` flow.
- Session lifecycle: `session/new` / `prompt` / `cancel`; later `load` / `resume` / `list`.
- Client-side method handlers the agent invokes: `fs/read_text_file` + `fs/write_text_file`
  (route through the existing file layer — the seam that makes edits visible), and
  `terminal/*` (route through `node-pty`).
- `session/request_permission` → forward to renderer, await choice, respond.
- Forward `session/update` notifications to the renderer over new `acp:*` IPC channels.

**Renderer — new components:**
- Conversation view: streaming chunks, thought blocks, tool-call cards (kind/status/content/
  locations), diffs (Monaco), plan view, mode switcher.
- Permission dialog.
- Agent/model picker per session (ties into the [model layer](./local-models.md)).

**Shared:** new `acp:*` IPC namespace; a `kind: 'acp'` session (see below).

## Costs / risks (honest)

- **We own the whole agent frontend** — currently free via Claude's TUI; now a build +
  ongoing maintenance that must track ACP's evolution.
- **Fidelity gap** — ACP is a normalized subset. Claude-specific UX (some slash commands,
  subagent viz, `/compact`, custom status, exact Anthropic feel) won't all surface; we
  reconstruct a generic version.
- **Capability long-tail** — every agent implements a different subset; need graceful
  degradation (no `loadSession` → no history restore, etc.).
- **Backend maturity** — Gemini CLI is the native reference impl; OpenCode is native ACP and
  provider-agnostic; **Claude Code appears to go via Zed's `claude-code-acp` adapter, not a
  native CLI mode** (verify — a third-party dependency risk).

## How tool provision works (no capability degradation)

The client-provided `fs/*` and `terminal/*` methods are **not** the model's tools — they're a
delegation channel for the *I/O* that the agent's own tools perform. The agent keeps its full
shipped toolset and reasoning loop; ACP only changes *where* file reads/writes and commands
physically happen.

- **Read / Write / Edit** — the agent routes the actual read/write through our `fs/*` **if we
  advertise the capability**, specifically so it sees the user's **unsaved editor buffer** and
  we can apply/track changes live (a gain). The methods are strictly optional and
  capability-gated: if we don't advertise `readTextFile`/`writeTextFile`, the agent MUST NOT
  call them and uses its own disk I/O — still works, less integrated.
- **Bash / commands** — routed through our `terminal/*` if advertised (visible inline,
  consistent env, killable); otherwise the agent runs them in its own subprocess.
- **Grep / Glob / WebSearch / WebFetch / MCP / subagents / TodoWrite / thinking** — ACP has
  **no client method** for these, so the agent uses its own implementation, unchanged. They
  surface to us as `session/update` tool-call events we *render but don't execute*.

Notes:
- **Edit stays smart.** With only whole-file `fs/write_text_file`, the agent still runs its own
  surgical edit logic in memory and persists the result; the precise old→new diff arrives in
  the tool call's `diffs` field (render in Monaco). No degradation to clumsy full rewrites.
- **Buffer-vs-disk wrinkle.** Reads/writes are delegated but grep/glob/search are not, so the
  agent's search sees *on-disk* content while its reads see the *unsaved buffer* — a possible
  inconsistency (agent greps, misses unsaved text, then reads and sees it). Minor, but real.
- **Touched-file tracking** should read the tool-call `locations` field (reported for *all*
  tool calls), not intercept `fs/*` — not everything flows through `fs/*`.
- **Scoping dial.** Advertising `fs` is near-pure upside → do it. `terminal/*` is more work, so
  a legit **v1 advertises `fs` but defers terminal** (agent self-runs commands meanwhile).

## Auth & billing (per backend)

| Backend | Auth | Cost |
| --- | --- | --- |
| Claude Code via ACP | your Claude **subscription** (OAuth `/login`) — the adapter wraps the Claude Code CLI, so it authenticates like Claude Code does | on your Pro/Max plan, no API key |
| Gemini CLI | Google-account login (free Code Assist tier) — Gemini CLI owns its own auth; or `GEMINI_API_KEY` | **free** (60 req/min, 1000 req/day); paid tiers optional |
| OpenCode → Claude | `ANTHROPIC_API_KEY` (third-party client, can't use the subscription) | pay-per-token |
| OpenCode → Ollama | none (local) | free |

**Spawning Gemini CLI:** install via npm, spawn with `--experimental-acp` (JSON-RPC over
stdio; without it the CLI hangs trying to launch its TUI). Gemini manages its own login, so
SimpleEdit's spike just spawns the process. Caveats: first-time OAuth is a browser flow best
done by running `gemini` once interactively (then ACP reuses stored creds); and — the same
credential-precedence theme — a stray `GEMINI_API_KEY`/`GOOGLE_AI_API_KEY` in the env
overrides the more generous account-login tier.

This clarifies backend roles: **Claude-Code-over-ACP is the "use Claude on my plan" backend;
OpenCode is the local/other-model backend** — they don't compete for the same slot.

**Footgun (must handle):** subscription-vs-API is decided by **credential precedence** — if
`ANTHROPIC_API_KEY` is present in the environment, Claude Code *silently* prefers it and bills
per-token even when the user intended their subscription. When SimpleEdit spawns
Claude-Code-over-ACP for subscription use, it must ensure no stray `ANTHROPIC_API_KEY` leaks
into the agent's env — and note the interactive-login-shell (`-i -l`) can re-inject one from
`~/.zshrc`. This is the mirror image of the local-model spike's inline-env gotcha
([local-models](./local-models.md)); same class of bug, opposite direction.

## Collision with the current architecture (and resolutions)

- **TUI embed vs. owned UI** — the whole point; resolved by coexistence (below), not removal.
- **Agent-first durable sessions** are built on Claude Code JSONL + `--session-id` / `--resume`
  / `--fork-session` (`claude-fork.ts`) + hook repo-trail. ACP has its **own** session model
  (`session/load` / `resume` / `list`) that doesn't map onto the JSONL/fork machinery. This is
  the deepest snag — an ACP session's persistence/fork story must be designed against ACP's
  primitives, not Claude's. **Open decision** below.
- **Hook-based cwd/repo-trail tracking** — superseded for ACP sessions by tool-call
  `locations` + the agent's `fs/*`/`terminal/*` calls (better data). A rewrite of the tracking
  layer, but a simplification.
- **MCP gen-UI bridge** — survives (agents accept MCP servers); reconcile overlap with native
  ACP diff/tool rendering.

## The key move: additive, as a new session `kind`

`SessionKind` is already `'claude' | 'agents' | 'terminal'`. Add **`'acp'`**. An ACP session
spawns its subprocess, speaks JSON-RPC, and renders in a **new** native conversation
component — while every existing `claude` TUI-embed session keeps working untouched. Ship it
with **one** backend first, evaluate against the TUI embed. If the native experience wins, it
becomes the default over time; if not, only the ACP lane is lost. This turns the
identity-level decision into a bounded experiment.

## How it fits the other plans

- **Model layer** ([local-models](./local-models.md)) — for an ACP session, model choice is
  per-agent. Notably **OpenCode-over-ACP + Ollama = a fully-owned local agent experience**
  (local model, we render the UI). The picker generalizes from "Claude/Ollama" to
  "which agent + which model".
- **Bounded-task substrate** ([bounded-tasks](./bounded-tasks.md)) — stays separate (headless
  workers). Its `Runner` interface must remain ACP-agnostic (already noted). An `AcpRunner`
  is *possible* later but bounded tasks don't need interactive session machinery — keep apart.

## Open decisions

- **Which backend first?** Options: Gemini CLI (cleanest, native reference), Claude Code via
  the ACP adapter (direct A/B against today's TUI), or OpenCode (unlocks the local-via-Ollama
  owned experience). Each answers a different question.
- **Coexist vs. eventually replace** the TUI embed. *Lean: coexist indefinitely; ACP is a
  session kind, not a replacement mandate.*
- **ACP session persistence/fork** vs. the agent-first pivot — do ACP sessions use
  `session/list`/`load`, and how does that reconcile with the pivot's durable-session store
  and Fork-into-worktree? Needs its own design pass.
- **v1 UI fidelity** — minimal (chunks + tool calls + Monaco diffs + permission) vs. full
  (plans, modes, thoughts, available-commands).
- **MCP overlap** — which gen-UI tools stay vs. defer to native ACP rendering.

## Non-goals

- Removing or deprecating the Claude TUI embed as part of this work.
- Making the bounded-task substrate depend on ACP.
- Implementing every ACP method in v1 — negotiate capabilities and degrade gracefully.
