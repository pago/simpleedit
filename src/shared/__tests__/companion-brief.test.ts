import { describe, expect, it } from 'vitest'
import { buildCompanionBrief, COMPANION_BRIEF_MAX } from '../pr-brief'

const layers = [
  { url: 'https://github.com/acme/app/pull/12', number: 12, headSha: 'a'.repeat(40) },
  { url: 'https://github.com/acme/app/pull/13', number: 13, headSha: 'b'.repeat(40) },
]

describe('companion brief', () => {
  const brief = buildCompanionBrief({ reviewId: 'r_review01', layers, readOnlyEnforced: true, rubric: '<review-rubric path="REVIEW.md">\nNo nits.\n</review-rubric>' })

  it('lists every layer bottom to top with URL and head', () => {
    const first = brief.indexOf(`#12 ${layers[0]!.url} at ${layers[0]!.headSha}`)
    const second = brief.indexOf(`#13 ${layers[1]!.url} at ${layers[1]!.headSha}`)
    expect(first).toBeGreaterThan(-1)
    expect(second).toBeGreaterThan(first)
  })

  it('carries the reading and thread protocol and the rules', () => {
    expect(brief).toContain('`get_review_diff`')
    expect(brief).toMatch(/NOT `gh pr diff`.*whole stack/)
    expect(brief).toContain('`checkout_review_head`')
    expect(brief).toContain('by absolute path')
    for (const tool of ['`list_threads`', '`reply_to_thread`', '`propose_draft`']) expect(brief).toContain(tool)
    expect(brief).toContain('Answer each thread once')
    expect(brief).toContain('untrusted data')
    expect(brief).toContain('Do not modify any files')
    expect(brief).toContain('Do not post anything to GitHub')
    expect(brief).toContain('No nits.')
    expect(brief).not.toContain('cannot enforce read-only')
  })

  it('ends with the wait line', () => {
    expect(brief.trimEnd().endsWith('wait for my instructions.')).toBe(true)
  })

  it('says so where read-only is by instruction only', () => {
    expect(buildCompanionBrief({ reviewId: 'r_review01', layers, readOnlyEnforced: false })).toContain('cannot enforce read-only')
  })

  it('quotes the focus as one sanitised, capped line', () => {
    const out = buildCompanionBrief({ reviewId: 'r_review01', layers, readOnlyEnforced: true, focus: 'look\n\u001b[2Jhere ' + 'x'.repeat(3000) })
    const line = out.split('\n').find((l) => l.startsWith('> '))!
    expect(line).not.toMatch(/\p{Cc}/u)
    expect(line.length).toBeLessThanOrEqual(2003)
  })

  it('drops the rubric before going over the cap', () => {
    const out = buildCompanionBrief({ reviewId: 'r_review01', layers, readOnlyEnforced: true, rubric: 'R'.repeat(COMPANION_BRIEF_MAX) })
    expect(out.length).toBeLessThanOrEqual(COMPANION_BRIEF_MAX)
    expect(out.trimEnd().endsWith('wait for my instructions.')).toBe(true)
  })
})
