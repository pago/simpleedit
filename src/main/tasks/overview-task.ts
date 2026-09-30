/**
 * The PR Overview task: a reviewer's briefing on one PR, read before the diff.
 *
 * The answer is fixed-section markdown, so the task runs in `output: 'text'`
 * mode and yields the model's final message verbatim. The cache stores that raw
 * text and `parseOverview` (shared) splits it on render, so a parser fix
 * applies to cached overviews too.
 *
 * Prompt = instructions (overridable, prompt `overview`) + contract + input.
 * The contract fixes the headings and the citation form the UI parses; the
 * header facts (author, state, reviews, CI, changeset) are rendered by code,
 * which is why the contract forbids a title or metadata line.
 */
import type { Task } from '../agent-tasks/orchestrator'
import { renderOverviewInput, type OverviewContext } from '../github/pr-overview-context'

export const OVERVIEW_PROMPT_VERSION = 1

/** The overridable part: what the briefing covers and how it is written. */
export const OVERVIEW_INSTRUCTIONS = `You are writing a reviewer's briefing on a GitHub pull request, read before the diff. It answers four things: what changed, why, what it affects, and where to spend review time. It is not a review: point at risk, don't adjudicate it. Deep review exists for findings.

- Be terse. No filler.
- Prefer facts to claims. Anything you infer rather than read in the input, prefix with *Inference:*.
- What changed: prose that cites \`path:line\`, using new-file line numbers from the hunk headers. Use a small table or a short fragment of new API surface only when it is clearer or shorter than prose.
- Why: from the description, the linked issues and the discussion. If none of them says, write "The PR doesn't say."
- Impact: exported API added, changed or removed; behaviour changes; feature flags; tests added; what CI and the changeset say. If a key file on the default branch has drifted from what the PR builds on, or a competing design landed while the PR was open, say so here. That is often the most important thing in the briefing.
- Look into: about 3–6 items, highest leverage first. Strategic questions ("should this merge at all, or as-is?") come before line-level ones. Each item names the question and where to look, never a verdict. More than six means you are drifting into a review. Don't repeat the existing triage or deep-review findings.
- Surface what the discussion settled: scope deferred to another PR, or an objection that was argued and overruled. A comment marked "(you)" is the reader's own; write "you noted".
- For a stacked PR the changeset may live in the lower layer. Say so rather than calling it missing.
- Never inline a diff or a before/after block. Describe the change and cite it.
- If the input lists something as not seen, don't guess about it; say it wasn't seen where that matters.`

const CONTRACT = `Answer in markdown with exactly these four sections, in this order, each a level-2 heading:

## What changed
## Why
## Impact
## Look into

"Look into" is a numbered list. Each item is one question followed by one or more citations in backticks, as \`path:line\` or \`path:start-end\`, with the full repo-relative path exactly as it appears after \`b/\` in the diff header. Never shorten a path; the app uses it to jump to that line.

Nothing before the first heading and nothing after the list: no title, no preamble, no metadata line (the app shows the PR's author, state, reviews, CI and changeset itself), and no closing offer. No other level-1 or level-2 headings.`

export function buildOverviewPrompt(instructions: string, ctx: OverviewContext): string {
  return `${instructions}

${CONTRACT}

The input follows. It was gathered for you; don't try to fetch more.

${renderOverviewInput(ctx)}`
}

/** The raw answer, or null for an empty one. Structure is judged on render, not here. */
export function parseOverviewText(obj: unknown): string | null {
  return typeof obj === 'string' && obj.trim() ? obj.trim() : null
}

/**
 * Context is gathered before the run (`gatherOverviewContext`), so
 * `buildContext` is identity. `instructions` is the effective, possibly
 * overridden text; the contract and the input are always SimpleEdit's.
 */
export function makeOverviewTask(instructions = OVERVIEW_INSTRUCTIONS): Task<OverviewContext, OverviewContext, string> {
  return {
    name: 'screenprs-overview',
    output: 'text',
    async buildContext(ctx) {
      return ctx
    },
    buildPrompt(ctx) {
      return { system: '', user: buildOverviewPrompt(instructions, ctx) }
    },
    parse: parseOverviewText,
  }
}
