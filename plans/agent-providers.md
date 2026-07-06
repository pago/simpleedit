# Plan: Agent providers — multi-backend via embedded TUIs

Status: draft (rough sketch; not scheduled) · Branch: `feat/local-review` · Worktree: `../local-review`

> Axis 1 (harness) in [agents-overview](./agents-overview.md), done the **pragmatic way**:
> keep embedding each agent's own rich TUI in a PTY (as we do Claude's today) and generalize
> the currently-hardwired Claude integration into pluggable **agent providers**. This is the
> preferred multi-backend path over [acp.md](./acp.md) — it keeps each agent's full native UX
> and costs far less, because our renderer is already a terminal. Deferred for now (OpenCode
> v2 is in flux; Antigravity CLI is brand new), so this is a rough shape, not a spec.

## Why this is cheap (the key realization)

SimpleEdit embeds a TUI and **renders a terminal, not a conversation UI**. So the renderer
(`Terminal.svelte` / xterm) is *already provider-agnostic* — it will display any agent's TUI
unchanged. The only provider-specific rendering is the sidebar **status** and **file-touch
highlighting**, both driven by main-process signals. Everything that's hardwired to Claude
lives in the **main process**, and it's code that already exists — so this abstraction is
mostly a *refactor into providers*, not new UI. That's the whole reason to prefer this over
ACP for multi-backend.

## What's hardwired to Claude today (the seam to abstract)

- **Launch** — `pty.ts` `spawnClaudeTerminal` / `spawnAgentsTerminal` (binary `claude`, flags,
  login-shell args).
- **Status** — `claude-stream.ts` scrapes OSC-0 window title (✳ = idle, braille = running) →
  `claude:status`.
- **Session identity / resume / fork** — `--session-id` / `--resume` / `--fork-session` +
  `claude-paths.ts` (JSONL dir encoding) + `claude-fork.ts`.
- **cwd / repo-trail tracking** — HTTP hooks via `writeHookSettings` (`--settings`) →
  `mcp-bridge.ts` `handleHook` → `cwd-tracker.ts`; emits `claude:file-touch` / `claude:cwd`.
- **MCP gen-UI bridge** — `--mcp-config` injecting `mcp-server/index.mjs`.
- **Session model** — `SessionKind = 'claude' | 'agents' | 'terminal'` in `sessions.svelte.ts`.

## The abstraction: an `AgentProvider`

A provider is a main-process adapter capturing everything that varies per agent, plus a
capability descriptor so the UI degrades gracefully:

```ts
interface AgentProvider {
  id: 'claude' | 'opencode' | 'antigravity'
  // How to launch the TUI in a PTY (binary, args, env — incl. model override / MCP / hooks).
  buildLaunch(session, opts): { command: string; args: string[]; env: Record<string,string> }
  // Turn raw PTY output into a status, or null if this provider has no rich signal.
  detectStatus?(chunk: string): ClaudeStatus | null
  // Optional wiring; no-op when unsupported.
  configureMcp?(session): void        // inject the gen-UI bridge via the provider's mechanism
  configureTracking?(session): void   // cwd/repo-trail via the provider's hook mechanism
  resume?(session): LaunchOverride     // how to restore a prior session
  fork?(session, target): Promise<void>
  capabilities: {
    status: 'osc' | 'basic'                        // 'basic' = running/exited from PTY lifecycle only
    resume: boolean
    fork: boolean
    tracking: 'full' | 'cwd-only' | 'none'         // repo/worktree trail fidelity (see below)
    mcp: boolean                                   // can host our gen-UI bridge
    modelOverride: 'env' | 'native' | 'none'
  }
}
```

The renderer reads `capabilities` to enable/disable affordances (e.g. hide "Fork into
worktree…" when `!fork` — the same pattern already used to disable fork for `agents`
sessions). Status falls back to running/exited when `status: 'basic'`.

**Resume/fork is explicitly quality-of-life, not a dealbreaker.** Keep Claude's JSONL/`--resume`/
`--fork-session` logic behind the provider, allow different logic for OpenCode/Antigravity, and
**skip the feature entirely (capability-gated) where the tool doesn't support it** — a provider
without fork/resume is still fully usable, it just loses those conveniences.

## The three providers (capability matrix — TBDs flagged)

| Concern | **Claude Code** | **OpenCode** | **Antigravity CLI** |
| --- | --- | --- | --- |
| Launch (TUI in PTY) | `claude` | `opencode` (spawns JS server + Go TUI) | `antigravity` (Go TUI) |
| Model override | `ANTHROPIC_BASE_URL` + `--model` (see [local-models](./local-models.md)) | **native** — any provider incl. Ollama | Google models (Antigravity harness) |
| Status signal | OSC-0 title — **rich** | TBD → likely `basic` | TBD → likely `basic` |
| Resume | `--session-id` / `--resume` + JSONL | server/session store (own) | conversation history (own) — TBD |
| Fork-into-worktree | yes (JSONL copy + `--fork-session`) | maybe via session clone — TBD | TBD → likely disable initially |
| Hooks (cwd/repo-trail) | HTTP hooks via `--settings` | hooks / plugins | **hooks** (kept from Gemini) → likely portable |
| MCP gen-UI bridge | `--mcp-config` | `mcp` in opencode config | plugins/extensions + MCP |
| Auth | Claude subscription / API key | API key / **local (Ollama, free)** | Google OAuth **device-code** (URL+code shown in the embedded TUI — works in a PTY) |

Composition: **provider = harness (this doc); `ModelRef` = model ([local-models](./local-models.md))**.
"Claude + Ollama" is the Claude provider with an env model override; "OpenCode + Ollama" is
the OpenCode provider with its native model config. The two axes compose cleanly.

## Repo/worktree tracking (the hard part — not the terminal)

The repo & worktree pickers are a SimpleEdit differentiator and are **not** derived from the
terminal — they're powered by **Claude Code's hooks**. Each session launches with a
`--settings` file wiring `UserPromptSubmit` + `PostToolUse` HTTP hooks to the per-window bridge
(`writeHookSettings` → `mcp-bridge.ts handleHook` → `cwd-tracker.ts`), producing two signals:

- **`cwd`** (`claude:cwd`) — where the agent *is*; changes on Bash `cd` / worktree tools;
  repoints the workspace view.
- **`tool_input.file_path`** (`claude:repo-touch`) — files read/edited, *including sibling
  repos the cwd never entered*; resolved via `resolveBareRepo`, fed to `touchedReposForSession`
  → `RepoPicker`. (Both signals exist because of the `session-repo-trail` bug: cwd-only misses
  cross-repo touches.)

None of this ports for free — a different agent's TUI in a PTY emits none of it. Three pieces:

1. **Normalize the sink** (mostly provider-agnostic already). Bridge + `cwd-tracker` become a
   neutral touch intake: given `{ sessionId, cwd?, filePath? }`, record + resolve the repo +
   emit a neutral signal (`session:cwd` / `session:repo-touch`, not `claude:*`). The consumer
   side — `touchedReposForSession`, the pickers, `resolveBareRepo` — barely changes.
2. **Per-provider `configureTracking(session)`** feeds that sink via each agent's mechanism:
   Claude = existing `--settings` HTTP hooks; **Antigravity** = its retained hooks (new payload
   parser; if command-type not HTTP, inject a tiny reporter command that posts to the bridge —
   a general pattern); **OpenCode** = a plugin posting to the bridge, or its server event
   stream (richer — the server already knows every tool/file).
3. **Capability tiers + generic fallbacks** so a provider that can't feed the sink degrades
   instead of the picker going dead:
   - **`full`** (Claude; likely Antigravity/OpenCode via hooks/API) — cwd + precise cross-repo
     file-touch.
   - **`cwd-only`** — provider-agnostic fallback: poll the PTY foreground-process cwd (node-pty
     gives the pid). Recovers workspace-repointing on `cd` for *any* agent, but **misses
     sibling-repo file reads** (they don't move cwd).
   - **`none`** — launch-dir only; optionally supplement with coarse chokidar-watcher / `git
     status` inference during an active session (approximate, unattributed).

**Honest cost:** full-fidelity trail — especially the sibling-repo touches that make the
picker useful — depends on the provider cooperating (hooks or a server event stream). The
generic PTY-cwd fallback recovers repointing but not cross-repo attribution. So this is a real,
per-provider integration cost to budget beyond "embed the TUI."

## Moving-target caveats (why it's a sketch)

- **OpenCode v2** is churning its client/server split (Hono server, PTY/TUI WebSocket routes).
  Two integration options — **(a) embed the `opencode` TUI in a PTY** (uniform with the rest,
  do this first) or **(b) drive `opencode serve` via its HTTP/WS API** (deeper, structured,
  more like an OpenCode-specific ACP). Don't pin to v1 internals; prefer (a) for the
  abstraction, keep (b) as an OpenCode-only escape hatch.
- **Antigravity CLI** is brand new (May 2026) and evolving; treat flags/paths as unstable.
  Keep the provider capability-driven so a missing feature just flips a flag off.

## Graceful degradation rules

- No rich status → `basic` (running/exited); the sidebar spinner still works, just coarser.
- No `fork` / `resume` → hide those menu actions for that provider (existing precedent).
- Tracking tier (`full` / `cwd-only` / `none`) drives the repo/worktree pickers — see the
  dedicated section above; `cwd-only` recovers repointing but not cross-repo attribution.
- No `mcp` → the gen-UI bridge (`show_panel`, `show_diff`, …) is unavailable for that provider;
  features that depend on it must detect and degrade.

## Files / touch-points (provisional)

**New**
- `src/main/agents/provider.ts` — the `AgentProvider` interface + a registry.
- `src/main/agents/claude.ts`, `opencode.ts`, `antigravity.ts` — implementations.

**Refactored (Claude logic moves into `claude.ts`)**
- `src/main/pty.ts` — `spawnClaudeTerminal` becomes provider-driven `spawnAgentTerminal`.
- `src/main/claude-stream.ts`, `claude-paths.ts`, `claude-fork.ts`, hook wiring — become the
  Claude provider's `detectStatus` / `resume` / `fork` / `configureTracking`.
- `src/renderer/stores/sessions.svelte.ts` + `src/shared/ipc-types.ts` — generalize
  `SessionKind` to carry a `provider` (keep `'terminal'` as the non-agent kind); route spawn
  by provider; read `capabilities` for menu gating.

**Mostly unchanged**
- `Terminal.svelte` (renders any PTY), the workspace/diff-review layer.

## Build sequence

1. **Extract the Claude provider** — define `AgentProvider`, move all Claude-specific logic
   behind it (incl. **normalizing the tracking sink** to `session:cwd`/`session:repo-touch`),
   register it, route `spawnClaudeTerminal` through the registry. Behavior identical; pure
   refactor. This alone is the valuable step (turns the hardwired integration into an
   abstraction) and de-risks everything after. Guard with `session-repo-trail.test.ts`.
2. **Add one more provider** to validate the seam — Antigravity CLI is the cleaner first
   addition (single embeddable TUI, device-code auth, hooks for tracking). Wire launch +
   `basic` status; wire `configureTracking` for at least `cwd-only`, aim for `full` via its
   hooks; disable fork/resume until mapped.
3. **OpenCode** via embedded TUI (option (a)); evaluate the server API (option (b)) separately
   once v2 settles.

## Open decisions

- **Session-model shape** — `provider` field vs. expanding `SessionKind`; how per-provider
  resume/fork slots into the agent-first durable-session store.
- **OpenCode integration mode** — embedded TUI vs. server API (revisit post-v2).
- **How much tracking to port** to non-Claude providers (hooks exist in Antigravity/OpenCode)
  vs. accept `basic` and lean on the (future) diff-review layer.

## Non-goals

- Owning/normalizing the conversation UI — that's ACP ([acp.md](./acp.md)), explicitly not this.
- Building anything now; this is the shape to reach for when a second interactive backend is
  actually wanted.
