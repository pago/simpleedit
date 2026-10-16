import { describe, expect, it } from 'vitest'
import { isOwned, parseSessionOwner } from '../session-owner'

describe('session ownership', () => {
  it('accepts only a valid Review Room owner', () => {
    const owner = parseSessionOwner({ kind: 'review', reviewId: 'r_review01', ignored: true })
    expect(owner).toEqual({ kind: 'review', reviewId: 'r_review01' })
    expect(isOwned({ owner })).toBe(true)
    expect(parseSessionOwner({ kind: 'review', reviewId: '../bad' })).toBeUndefined()
    expect(isOwned(null)).toBe(false)
  })
})
