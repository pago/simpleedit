import { describe, expect, it } from 'vitest'
import { isOwned, parseSessionOwner, plainSessionOwner } from '../session-owner'

describe('session ownership', () => {
  it('accepts only a valid Review Room owner', () => {
    const owner = parseSessionOwner({ kind: 'review', reviewId: 'r_review01', ignored: true })
    expect(owner).toEqual({ kind: 'review', reviewId: 'r_review01' })
    expect(isOwned({ owner })).toBe(true)
    expect(parseSessionOwner({ kind: 'review', reviewId: '../bad' })).toBeUndefined()
    expect(isOwned(null)).toBe(false)
  })

  it("round-trips a loop reviewer's owner and a map child's", () => {
    const reviewer = { kind: 'workflow', workflowId: 'wf_abcdef123', taskId: 'impl', attempt: 2, review: 3 } as const
    expect(parseSessionOwner(reviewer)).toEqual(reviewer)
    expect(plainSessionOwner(reviewer)).toEqual(reviewer)
    const worker = { kind: 'workflow', workflowId: 'wf_abcdef123', taskId: 'fix.12', attempt: 1 } as const
    expect(parseSessionOwner(worker)).toEqual(worker)
    expect(plainSessionOwner(worker)).not.toHaveProperty('review')
  })

  it.each([0, 1.5, '2', null])('refuses an owner whose review is %j', (review) => {
    expect(parseSessionOwner({ kind: 'workflow', workflowId: 'wf_abcdef123', taskId: 'impl', attempt: 1, review })).toBeUndefined()
  })
})
