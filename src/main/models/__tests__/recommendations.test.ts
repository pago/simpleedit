import { describe, it, expect } from 'vitest'
import { computeFit, RECOMMENDED_MODELS } from '../recommendations'

const TOTAL = 32 * 1024 ** 3 // 32 GB

describe('computeFit', () => {
  it("'fits' at exactly 70% of total", () => {
    expect(computeFit(TOTAL * 0.7, TOTAL)).toBe('fits')
  })

  it("'marginal' just above 70%", () => {
    expect(computeFit(TOTAL * 0.7 + 1, TOTAL)).toBe('marginal')
  })

  it("'marginal' at exactly 100% of total", () => {
    expect(computeFit(TOTAL, TOTAL)).toBe('marginal')
  })

  it("'too-big' just above total", () => {
    expect(computeFit(TOTAL + 1, TOTAL)).toBe('too-big')
  })

  it('well within budget fits', () => {
    expect(computeFit(4 * 1024 ** 3, TOTAL)).toBe('fits')
  })
})

describe('RECOMMENDED_MODELS', () => {
  it('are non-empty with unique names and positive RAM estimates', () => {
    expect(RECOMMENDED_MODELS.length).toBeGreaterThan(0)
    const names = RECOMMENDED_MODELS.map((m) => m.name)
    expect(new Set(names).size).toBe(names.length)
    for (const m of RECOMMENDED_MODELS) {
      expect(m.minRamBytes).toBeGreaterThan(0)
      expect(m.label).toBeTruthy()
    }
  })
})
