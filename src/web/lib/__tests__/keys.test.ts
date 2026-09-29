import { describe, it, expect } from 'vitest'
import { keyBytes, type AccessoryKey } from '../keys'

describe('accessory key bytes', () => {
  it('sends the normal cursor form by default', () => {
    expect(keyBytes('up', false)).toBe('\x1b[A')
    expect(keyBytes('down', false)).toBe('\x1b[B')
  })

  // A full-screen TUI sets DECCKM as a matter of course, and that is precisely
  // where a phone needs the arrows.
  it('sends the application cursor form when the terminal asked for it', () => {
    expect(keyBytes('up', true)).toBe('\x1bOA')
    expect(keyBytes('down', true)).toBe('\x1bOB')
  })

  it('leaves the non-cursor keys alone in either mode', () => {
    for (const application of [false, true]) {
      expect(keyBytes('enter', application)).toBe('\r')
      expect(keyBytes('escape', application)).toBe('\x1b')
      expect(keyBytes('tab', application)).toBe('\t')
    }
  })

  it('covers every key the bar offers', () => {
    const keys: AccessoryKey[] = ['up', 'down', 'enter', 'escape', 'tab']
    for (const key of keys) expect(keyBytes(key, false).length).toBeGreaterThan(0)
  })
})
