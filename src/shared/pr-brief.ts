/**
 * The seed prompt of a "Discuss with Agent" session on a PR. Shared so the
 * desk and the phone start the same review conversation from the same facts.
 */
import type { DeepFinding, PrContext, TriageFinding } from './screenprs'
import type { OverviewLookIntoItem } from './pr-overview'

export interface PrBriefInput {
  context: Pick<PrContext, 'url' | 'repo' | 'number' | 'title' | 'baseRefName' | 'additions' | 'deletions' | 'changedFiles' | 'base'>
  triage?: readonly TriageFinding[]
  /** The overview's raw markdown, when one has been written. */
  overview?: string
  deep?: readonly DeepFinding[]
  /** A Look-into question to start from. */
  focus?: OverviewLookIntoItem
}

const CUT = '\n\n(The rest of the overview was cut for length.)'

/**
 * The brief, kept within `max` characters when given — the phone's sends are
 * bounded by main. What gives way first is what the agent can re-derive: the
 * deep findings' detail, then the overview's tail. The PR, its findings'
 * titles and the question to start from always stay.
 */
export function buildPrBrief(input: PrBriefInput, max?: number): string {
  const full = render(input, false)
  if (max === undefined || full.length <= max) return full
  const terse = render(input, true)
  if (terse.length <= max || !input.overview) return terse
  const keep = Math.max(0, input.overview.length - (terse.length - max) - CUT.length)
  return render({ ...input, overview: input.overview.slice(0, keep) + CUT }, true)
}

function render({ context, triage = [], overview, deep = [], focus }: PrBriefInput, withoutDeepDetail: boolean): string {
  const lines = [
    `You are helping me review a GitHub pull request. This is a REVIEW session — the PR is NOT ours to modify unless I explicitly ask. When I'm ready, you'll post the review to GitHub yourself with \`gh pr review\` (approve / comment / request-changes). Don't post anything until I tell you to.`,
    ``,
    `PR: ${context.url}`,
    `${context.repo}#${context.number} — ${context.title}  (base ${context.baseRefName}, +${context.additions}/−${context.deletions}, ${context.changedFiles} files)`,
  ]
  if (context.base?.kind === 'polluted') {
    lines.push('', `Careful: \`gh pr diff\` includes ${context.base.foreign} commit(s) from the lower stack layer. Review only this PR's own commits:`)
    for (const c of context.base.own) lines.push(`- ${c.sha.slice(0, 8)} ${c.subject}`)
  }
  if (triage.length) {
    lines.push('', 'Triage (diff-only) flagged:')
    for (const f of triage) lines.push(`- [${f.label}] ${f.file}${f.line ? ':' + f.line : ''} — ${f.title}`)
  }
  if (overview) {
    lines.push('', 'The PR overview (what changed, why, impact, what to look into):', '', overview)
  }
  if (deep.length) {
    lines.push('', 'Deep review flagged:')
    for (const f of deep) {
      const head = `- [${f.severity}/${f.lens}] ${f.file}${f.line ? ':' + f.line : ''} — ${f.title}`
      lines.push(withoutDeepDetail ? head : `${head}: ${f.detail}`)
    }
  }
  if (focus) lines.push('', `I want to dig into this question from the overview first:`, focus.markdown)
  lines.push(
    '',
    `Start by running \`gh pr diff ${context.url}\` to see the change (and \`gh pr checkout\` if you want to run it), then help me decide whether it's ready.`
  )
  return lines.join('\n')
}

/** The session's name in the list — fixed, not provisional: it names the PR, not the conversation. */
export function prSessionLabel(context: Pick<PrContext, 'repo' | 'number'>): string {
  return `review ${context.repo}#${context.number}`
}
