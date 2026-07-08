/**
 * Deep-review lenses + the synthesis reduce (plans/screen-prs.md §3.2). Each lens
 * is a focused, self-contained review `Task` over the PR diff; a synthesis task
 * then dedups/ranks/drops-noise across all lens findings. All diff-only for now
 * (the repo-aware pass on a checked-out worktree lands with the Discuss/handoff
 * work) — so every lens runs self-contained under either runner.
 */
import type { PrContext, DeepFinding, DeepLensId, DeepSeverity } from '../../shared/screenprs'
import type { Task } from '../agent-tasks/orchestrator'

const MAX_DIFF_BYTES = 80_000
const MAX_BODY_BYTES = 2_000
const VALID_SEVERITY = new Set<DeepSeverity>(['blocking', 'concern', 'note'])
const VALID_LENS = new Set<DeepLensId>(['intent', 'tests', 'soundness', 'types', 'architecture'])

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '\n…[truncated]' : s
}

const OUTPUT_SPEC = `Output ONLY NDJSON — one JSON object per line, no prose, no code fences. Each object:
{"severity":"blocking|concern|note","file":"path","line":"12 or 12-18","title":"one line, max 80 chars","detail":"the specific evidence AND a concrete fix"}
Governing rule: PRECISION OVER RECALL. Only findings that are real, consequential, and introduced by THIS diff. If the diff is clean for your lens, output nothing. Never pad. "severity": blocking = must-fix (bug/risk), concern = should address, note = minor.`

const LENS_PROMPT: Record<DeepLensId, string> = {
  soundness: `You are reviewing ONE lens of a pull request: SOUNDNESS & CORRECTNESS. Look only for bugs, logic errors, off-by-one, unhandled null/undefined, missed edge cases, race conditions, data-integrity hazards, and error handling (swallowed errors, unsafe fallbacks, missing failure paths). Ignore style, naming, tests, and architecture — other lenses cover those.`,
  intent: `You are reviewing ONE lens of a pull request: INTENT vs. IMPLEMENTATION. Judge whether the code does what the PR's title and description claim. Flag mismatches, missing pieces the description promises, behavior that contradicts the stated goal, and unrelated scope creep. Do not hunt for generic bugs — that's another lens.`,
  tests: `You are reviewing ONE lens of a pull request: TEST COVERAGE. Judge whether the diff adds or updates tests for the behavior it changes. Flag new/changed logic left untested, and obviously missing edge cases. Do not review the non-test code for bugs — that's another lens.`,
  types: `You are reviewing ONE lens of a pull request: TYPE SAFETY. Flag unsafe casts, \`any\` leaks, non-null assertions on possibly-null values, and type regressions this diff introduces. Ignore issues a type-checker would already flag.`,
  architecture: `You are reviewing ONE lens of a pull request: ARCHITECTURE & DESIGN. Flag only concrete, nameable problems: a responsibility in the wrong layer, a leaky abstraction, coupling that will be costly. Only when you can name the problem and a better home for the code. Do not nitpick.`,
}

function buildLensPrompt(lens: DeepLensId, ctx: PrContext): string {
  return `${LENS_PROMPT[lens]}

${OUTPUT_SPEC}

PR: ${ctx.repo}#${ctx.number} — ${ctx.title}
${ctx.body ? `\nDescription:\n${truncate(ctx.body, MAX_BODY_BYTES)}\n` : ''}
<diff>
${truncate(ctx.diff, MAX_DIFF_BYTES)}
</diff>`
}

function parseFinding(lens: DeepLensId | null, obj: unknown): DeepFinding | null {
  if (typeof obj !== 'object' || obj === null) return null
  const o = obj as Record<string, unknown>
  // For lens tasks the lens is injected; for synthesis it must be present + valid.
  const resolvedLens = lens ?? (VALID_LENS.has(o['lens'] as DeepLensId) ? (o['lens'] as DeepLensId) : null)
  if (!resolvedLens) return null
  if (!VALID_SEVERITY.has(o['severity'] as DeepSeverity)) return null
  if (typeof o['file'] !== 'string' || !o['file']) return null
  if (typeof o['title'] !== 'string' || !o['title']) return null
  if (typeof o['detail'] !== 'string' || !o['detail']) return null
  return {
    lens: resolvedLens,
    severity: o['severity'] as DeepSeverity,
    file: o['file'],
    line: typeof o['line'] === 'string' ? o['line'] : typeof o['line'] === 'number' ? String(o['line']) : undefined,
    title: o['title'],
    detail: o['detail'],
  }
}

/** A single-lens review task; context is pre-gathered (identity buildContext). */
export function makeLensTask(lens: DeepLensId): Task<PrContext, PrContext, DeepFinding> {
  return {
    name: `deep-lens:${lens}`,
    async buildContext(ctx) {
      return ctx
    },
    buildPrompt(ctx) {
      return { system: '', user: buildLensPrompt(lens, ctx) }
    },
    parse: (obj) => parseFinding(lens, obj),
  }
}

export interface SynthesisInput {
  ctx: PrContext
  raw: DeepFinding[]
}

function buildSynthesisPrompt(input: SynthesisInput): string {
  const raw = input.raw
    .map((f) => `- [${f.lens}/${f.severity}] ${f.file}${f.line ? ':' + f.line : ''} — ${f.title}: ${f.detail}`)
    .join('\n')
  return `You are the review lead consolidating findings from several review lenses on one pull request. Below are the RAW findings and the diff. Produce the final review:
- DROP any finding the diff does not actually support (be skeptical — kill weak or speculative ones).
- MERGE duplicates/overlaps across lenses into a single finding (keep the clearest wording and the HIGHEST severity).
- KEEP only what is worth the author's attention. Fewer, well-evidenced findings beat many shaky ones.

${OUTPUT_SPEC}
Additionally, each object MUST include "lens" (one of: soundness, intent, tests, types, architecture) — carry over the originating lens of the finding you keep.

<raw-findings>
${raw || '(none)'}
</raw-findings>

<diff>
${truncate(input.ctx.diff, MAX_DIFF_BYTES)}
</diff>`
}

/** The synthesis reduce: curate/dedup/rank all lens findings into the final set. */
export const synthesisTask: Task<SynthesisInput, SynthesisInput, DeepFinding> = {
  name: 'deep-synthesis',
  async buildContext(input) {
    return input
  },
  buildPrompt(input) {
    return { system: '', user: buildSynthesisPrompt(input) }
  },
  parse: (obj) => parseFinding(null, obj),
}

export { parseFinding as _parseFinding }
