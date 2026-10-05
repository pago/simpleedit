import { describe, it, expect } from 'vitest'
import { buildPrBrief, prSessionLabel } from '../pr-brief'
import type { PrBriefInput } from '../pr-brief'

const context: PrBriefInput['context'] = {
  url: 'https://github.com/acme/app/pull/7',
  repo: 'acme/app',
  number: 7,
  title: 'Tighten the gate',
  baseRefName: 'main',
  additions: 12,
  deletions: 3,
  changedFiles: 2,
}

describe('buildPrBrief', () => {
  it('frames a review session on the PR', () => {
    const brief = buildPrBrief({ context })
    expect(brief).toContain('This is a REVIEW session')
    expect(brief).toContain('acme/app#7 — Tighten the gate  (base main, +12/−3, 2 files)')
    expect(brief).toContain('gh pr diff https://github.com/acme/app/pull/7')
    expect(brief).not.toContain('Triage')
  })

  it('carries the findings, the overview and the question to start from', () => {
    const brief = buildPrBrief({
      context,
      triage: [{ label: 'issue', file: 'a.ts', line: '5', title: 'Off by one' }],
      overview: '## What changed\nThe gate.',
      deep: [{ severity: 'blocking', lens: 'soundness', file: 'b.ts', title: 'Race', detail: 'Two writers.' }],
      focus: { markdown: 'Why is the lock dropped early?', refs: [] },
    } as PrBriefInput)
    expect(brief).toContain('- [issue] a.ts:5 — Off by one')
    expect(brief).toContain('## What changed\nThe gate.')
    expect(brief).toContain('- [blocking/soundness] b.ts — Race: Two writers.')
    expect(brief).toContain('dig into this question from the overview first:\nWhy is the lock dropped early?')
  })

  it('warns about a polluted stacked diff', () => {
    const brief = buildPrBrief({
      context: { ...context, base: { kind: 'polluted', foreign: 2, own: [{ sha: 'abcdef1234', subject: 'Mine' }] } } as PrBriefInput['context'],
    })
    expect(brief).toContain('includes 2 commit(s) from the lower stack layer')
    expect(brief).toContain('- abcdef12 Mine')
  })
})

it('names the session after the PR', () => {
  expect(prSessionLabel(context)).toBe('review acme/app#7')
})

describe('buildPrBrief with a bound', () => {
  const big = {
    context,
    triage: [{ label: 'issue', file: 'a.ts', title: 'Off by one' }],
    overview: 'O'.repeat(5_000),
    deep: [{ severity: 'concern', lens: 'soundness', file: 'b.ts', title: 'Race', detail: 'D'.repeat(3_000) }],
    focus: { markdown: 'Why is the lock dropped early?', refs: [] },
  } as PrBriefInput

  it('is unchanged when it fits', () => {
    expect(buildPrBrief(big, 100_000)).toBe(buildPrBrief(big))
  })

  it('drops the deep findings\' detail first', () => {
    const brief = buildPrBrief(big, 6_500)
    expect(brief.length).toBeLessThanOrEqual(6_500)
    expect(brief).toContain('— Race')
    expect(brief).not.toContain('DDD')
    expect(brief).toContain('O'.repeat(5_000))
  })

  it('then cuts the overview, keeping the PR, the findings and the question', () => {
    const brief = buildPrBrief(big, 3_000)
    expect(brief.length).toBeLessThanOrEqual(3_000)
    expect(brief).toContain('cut for length')
    expect(brief).toContain('Off by one')
    expect(brief).toContain('Why is the lock dropped early?')
  })
})

it('writes a deep finding exactly as the desk always has, empty detail included', () => {
  const brief = buildPrBrief({
    context,
    deep: [{ severity: 'note', lens: 'soundness', file: 'b.ts', title: 'Race', detail: '' }],
  } as PrBriefInput)
  expect(brief).toContain('- [note/soundness] b.ts — Race: \n')
})
