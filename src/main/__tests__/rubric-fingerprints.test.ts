import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))
vi.mock('../screenprs', () => ({ reviewDiffFor: async () => '' }))

import { overviewFingerprint } from '../pr-overview'
import { deepReviewFingerprint } from '../deep-review'

/** The overview and deep-review caches must miss when the repo's REVIEW.md changes. */
const rubric = { path: 'REVIEW.md', text: 'Skip generated/.' }
const lenses = [{ lens: 'soundness' as const, instructions: 'i' }]

describe('rubric in the cache fingerprints', () => {
  it('overview: a rubric, or a changed one, changes the fingerprint; none is stable', () => {
    const none = overviewFingerprint(undefined, 'i')
    expect(overviewFingerprint(undefined, 'i', undefined)).toBe(none)
    expect(overviewFingerprint(undefined, 'i', rubric)).not.toBe(none)
    expect(overviewFingerprint(undefined, 'i', { ...rubric, text: 'Nits are fine.' })).not.toBe(overviewFingerprint(undefined, 'i', rubric))
    expect(overviewFingerprint(undefined, 'i', { ...rubric, path: 'ui/REVIEW.md' })).not.toBe(overviewFingerprint(undefined, 'i', rubric))
  })

  it('deep review: a rubric, or a changed one, changes the fingerprint; none is stable', () => {
    const none = deepReviewFingerprint(lenses, undefined, 's')
    expect(deepReviewFingerprint(lenses, undefined, 's', undefined)).toBe(none)
    expect(deepReviewFingerprint(lenses, undefined, 's', rubric)).not.toBe(none)
    expect(deepReviewFingerprint(lenses, undefined, 's', { ...rubric, text: 'x' })).not.toBe(deepReviewFingerprint(lenses, undefined, 's', rubric))
  })
})
