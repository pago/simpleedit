/**
 * The Screen PRs triage task: a diff-only judgment of one PR, meant for a cheap
 * local model via `DirectRunner`. The context is gathered up front over `gh`
 * (plans/screen-prs.md §3.1), so `buildContext` is identity — the model only
 * reads the diff + PR description and emits a single `{impact, findings}` object.
 * The bucket is derived from this plus metadata by `bucketOf` (shared), not here.
 */
import type { PrContext, TriageResult, TriageFinding, TriageImpact } from '../../shared/screenprs'
import type { ConventionalCommentLabel } from '../../shared/ipc-types'
import type { Task } from '../agent-tasks/orchestrator'

const MAX_DIFF_BYTES = 60_000
const MAX_BODY_BYTES = 2_000

// Triage flags only the high-signal, actionable labels — no praise/nit padding.
const VALID_LABELS = new Set<ConventionalCommentLabel>(['issue', 'suggestion', 'question'])
const VALID_IMPACT = new Set<TriageImpact>(['low', 'medium', 'high'])

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '\n…[truncated]' : s
}

function buildTriagePrompt(ctx: PrContext): string {
  return `You are triaging a pull request to decide whether it needs a human reviewer's attention. You are NOT doing a full review — just a fast, diff-only judgment.

Output EXACTLY ONE JSON object and nothing else (no prose, no code fences):
{"impact":"low|medium|high","findings":[{"label":"issue|suggestion|question","file":"path","line":"12 or 12-18","title":"one line, max 80 chars"}]}

- "impact" = blast radius / risk of this change: high = architectural, security-sensitive, or wide-reaching; low = trivial/localized.
- "findings" = only concrete, high-signal concerns visible in the diff (a likely bug, a risky change, a real question). Empty array if the diff looks clean — do NOT invent findings, and do NOT include praise or nitpicks.
- Judge only what THIS diff changes. Something a type-checker/linter would catch is not a finding.

PR: ${ctx.repo}#${ctx.number} — ${ctx.title}
${ctx.body ? `\nDescription:\n${truncate(ctx.body, MAX_BODY_BYTES)}\n` : ''}
<diff>
${truncate(ctx.diff, MAX_DIFF_BYTES)}
</diff>`
}

export function parseTriage(obj: unknown): TriageResult | null {
  if (typeof obj !== 'object' || obj === null) return null
  const o = obj as Record<string, unknown>
  if (!VALID_IMPACT.has(o['impact'] as TriageImpact)) return null
  if (!Array.isArray(o['findings'])) return null
  const findings: TriageFinding[] = []
  for (const raw of o['findings']) {
    if (typeof raw !== 'object' || raw === null) continue
    const f = raw as Record<string, unknown>
    if (!VALID_LABELS.has(f['label'] as ConventionalCommentLabel)) continue
    if (typeof f['file'] !== 'string' || !f['file']) continue
    if (typeof f['title'] !== 'string' || !f['title']) continue
    findings.push({
      label: f['label'] as ConventionalCommentLabel,
      file: f['file'],
      line: typeof f['line'] === 'string' ? f['line'] : typeof f['line'] === 'number' ? String(f['line']) : undefined,
      title: f['title'],
    })
  }
  return { impact: o['impact'] as TriageImpact, findings }
}

/** Context is pre-gathered (the input *is* the context); `buildContext` is identity. */
export const triageTask: Task<PrContext, PrContext, TriageResult> = {
  name: 'screenprs-triage',
  async buildContext(ctx) {
    return ctx
  },
  buildPrompt(ctx) {
    return { system: '', user: buildTriagePrompt(ctx) }
  },
  parse: parseTriage,
}
