import { describe, it, expect } from 'vitest'
import { hasUserAttention } from '../attention'

/**
 * A stand-in for `document` — the real one in a test runner is always visible
 * and, depending on how the browser was launched, may or may not have focus.
 * The point of the predicate is the conjunction, so all four states have to be
 * reachable deliberately.
 */
function fakeDoc(hidden: boolean, focused: boolean): Document {
  return { hidden, hasFocus: () => focused } as unknown as Document
}

describe('hasUserAttention', () => {
  it('is true only when the tab is selected, visible and this window is focused', () => {
    expect(hasUserAttention(true, fakeDoc(false, true))).toBe(true)
  })

  it('is false for a selected tab in an unfocused window', () => {
    // The blur case the whole predicate exists for: a second window must not
    // take the size away from the one being read.
    expect(hasUserAttention(true, fakeDoc(false, false))).toBe(false)
  })

  it('is false while the document is hidden', () => {
    expect(hasUserAttention(true, fakeDoc(true, true))).toBe(false)
  })

  it('is false for a background tab, however focused the window is', () => {
    // Every session workspace stays mounted, so an unselected terminal is
    // still running this code on every focus event.
    expect(hasUserAttention(false, fakeDoc(false, true))).toBe(false)
  })

  it('is false when nothing is true', () => {
    expect(hasUserAttention(false, fakeDoc(true, false))).toBe(false)
  })

  it('reads the live document when none is passed', () => {
    // Guards the default argument: a mistake there would silently make every
    // caller test-only.
    expect(hasUserAttention(false)).toBe(false)
    expect(hasUserAttention(true)).toBe(!document.hidden && document.hasFocus())
  })
})
