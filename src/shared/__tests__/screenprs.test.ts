import { describe, it, expect } from 'vitest'
import { bucketOf, isCritical, compareInBucket, type ScreenPrCard, type TriageFinding } from '../screenprs'

const issue: TriageFinding = { label: 'issue', file: 'a.ts', title: 'bug' }
const suggestion: TriageFinding = { label: 'suggestion', file: 'a.ts', title: 'nit' }

function card(over: Partial<ScreenPrCard>): ScreenPrCard {
  const base: ScreenPrCard = {
    owner: 'ivx', repo: 'ui', number: 1, url: 'u', title: 't', author: 'a', updatedAt: '2026-07-01',
    additions: 10, deletions: 2, changedFiles: 1, baseRefName: 'main',
    ci: 'green', ciFailing: [], reviewers: [], approvedByOther: false, body: '', diff: '',
    impact: 'low', findings: [], bucket: 'quick',
  }
  const merged = { ...base, ...over }
  return { ...merged, bucket: bucketOf(merged) }
}

describe('isCritical', () => {
  it('is true for high impact or any issue finding', () => {
    expect(isCritical({ impact: 'high', findings: [] })).toBe(true)
    expect(isCritical({ impact: 'low', findings: [issue] })).toBe(true)
    expect(isCritical({ impact: 'low', findings: [suggestion] })).toBe(false)
    expect(isCritical({ impact: 'medium', findings: [] })).toBe(false)
  })
})

describe('bucketOf', () => {
  it('sends CI-failing PRs to waiting-on-author regardless of everything else', () => {
    expect(bucketOf({ ci: 'failing', approvedByOther: false, impact: 'high', findings: [issue] })).toBe('waiting')
  })
  it('surfaces approved-by-other only when critical, else FYI', () => {
    expect(bucketOf({ ci: 'green', approvedByOther: true, impact: 'high', findings: [] })).toBe('attention')
    expect(bucketOf({ ci: 'green', approvedByOther: true, impact: 'low', findings: [] })).toBe('fyi')
  })
  it('routes unapproved PRs by criticality', () => {
    expect(bucketOf({ ci: 'green', approvedByOther: false, impact: 'low', findings: [issue] })).toBe('attention')
    expect(bucketOf({ ci: 'pending', approvedByOther: false, impact: 'low', findings: [] })).toBe('quick')
  })
})

describe('compareInBucket', () => {
  it('orders attention worst-first (impact, then issue count)', () => {
    const hi = card({ impact: 'high', findings: [issue], number: 1 })
    const med = card({ impact: 'low', findings: [issue, issue], number: 2 }) // critical via issues
    expect(hi.bucket).toBe('attention')
    expect(med.bucket).toBe('attention')
    expect(compareInBucket(hi, med)).toBeLessThan(0) // high impact sorts first
  })
  it('orders quick smallest-first', () => {
    const small = card({ impact: 'low', additions: 1, deletions: 0, number: 1 })
    const big = card({ impact: 'low', additions: 90, deletions: 30, number: 2 })
    expect(small.bucket).toBe('quick')
    expect(compareInBucket(small, big)).toBeLessThan(0)
  })
  it('is a total order across buckets (attention before quick before waiting before fyi)', () => {
    const attn = card({ impact: 'high' })
    const quick = card({ impact: 'low' })
    const waiting = card({ ci: 'failing' })
    const fyi = card({ approvedByOther: true, impact: 'low' })
    const sorted = [fyi, waiting, quick, attn].sort(compareInBucket).map((c) => c.bucket)
    expect(sorted).toEqual(['attention', 'quick', 'waiting', 'fyi'])
  })
})
