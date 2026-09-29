import { describe, it, expect } from 'vitest'
import { qrMatrix } from '../qr'

const URL = 'https://mac.tail050858.ts.net/9f3c0a7e5b1d4826aa11cc22dd33ee44ff5566778899aabbccddeeff00112233/'

describe('qrMatrix', () => {
  it('encodes a pairing URL as a square matrix with a quiet zone', () => {
    const { size, path } = qrMatrix(URL)
    // Every QR version is (4v + 17) modules, plus a 4-module border each side.
    expect((size - 8 - 17) % 4).toBe(0)
    expect(path.length).toBeGreaterThan(0)
    // The border is empty by definition: nothing may be drawn in the first or
    // last four rows, or a scanner loses the finder pattern.
    expect(path).not.toMatch(/M\d+ [0-3]h/)
    expect(path).not.toMatch(new RegExp(`M\\d+ ${size - 1}h`))
  })

  it('produces a different matrix for a different token', () => {
    const a = qrMatrix(`${URL}a`)
    const b = qrMatrix(`${URL}b`)
    expect(a.path).not.toBe(b.path)
  })

  it('draws only unit squares, so the path renders in a size-by-size viewBox', () => {
    const { size, path } = qrMatrix('https://example.test/x/')
    for (const [, x, y] of path.matchAll(/M(\d+) (\d+)h1v1h-1z/g)) {
      expect(Number(x)).toBeLessThan(size)
      expect(Number(y)).toBeLessThan(size)
    }
    expect(path.replace(/M\d+ \d+h1v1h-1z/g, '')).toBe('')
  })
})
