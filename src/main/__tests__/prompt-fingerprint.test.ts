import { describe, it, expect, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const tmpRoot = mkdtempSync(join(tmpdir(), 'se-fingerprint-test-'))
vi.mock('electron', () => ({ app: { getPath: () => tmpRoot } }))
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }))

const { currentTriageFingerprint } = await import('../screenprs')
const { deepReviewFingerprint } = await import('../deep-review')
const { overviewFingerprint } = await import('../pr-overview')

describe('cache fingerprints hash the effective instructions', () => {
  it('triage: a different instruction text is a different fingerprint', () => {
    expect(currentTriageFingerprint('a')).toBe(currentTriageFingerprint('a'))
    expect(currentTriageFingerprint('a')).not.toBe(currentTriageFingerprint('b'))
  })

  it('deep review: changing one lens or the synthesis instructions changes the fingerprint', () => {
    const lenses = [
      { lens: 'soundness' as const, instructions: 'x' },
      { lens: 'tests' as const, instructions: 'y' },
    ]
    const base = deepReviewFingerprint(lenses, undefined, 'synth')
    expect(deepReviewFingerprint(lenses, undefined, 'synth')).toBe(base)
    expect(deepReviewFingerprint([lenses[0], { ...lenses[1], instructions: 'y2' }], undefined, 'synth')).not.toBe(base)
    expect(deepReviewFingerprint(lenses, undefined, 'synth2')).not.toBe(base)
  })

  it('overview: an override, a different model or runner each change the fingerprint', () => {
    const sonnet = { provider: 'anthropic' as const, model: 'sonnet' }
    const base = overviewFingerprint(sonnet, 'x')
    expect(overviewFingerprint(sonnet, 'x')).toBe(base)
    expect(overviewFingerprint(sonnet, 'x, edited')).not.toBe(base)
    expect(overviewFingerprint({ provider: 'anthropic', model: 'opus' }, 'x')).not.toBe(base)
    expect(overviewFingerprint({ provider: 'openai' }, 'x')).not.toBe(base)
  })
})
