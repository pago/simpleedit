import { describe, it, expect } from 'vitest'
import { EMPTY_PROMPT, applyKeys, isDraft } from '../prompt-model'

const after = (...writes: string[]): ReturnType<typeof applyKeys> => writes.reduce(applyKeys, EMPTY_PROMPT)

describe('prompt model', () => {
  it.each([
    ['Esc', '\x1b'],
    ['Shift+Tab', '\x1b[Z'],
    ['Left and Right', '\x1b[D\x1b[C'],
    ['Down', '\x1b[B'],
    ['a mouse report', '\x1b[<0;10;5M\x1b[<0;10;5m'],
    ['a function key', '\x1b[15~'],
    ['Enter on nothing', '\r'],
  ])('%s leaves an empty prompt empty', (_name, keys) => {
    expect(isDraft(after(keys))).toBe(false)
  })

  it('counts typed text, and backspacing it all away empties the prompt', () => {
    expect(isDraft(after('hi'))).toBe(true)
    expect(isDraft(after('hi', '\x7f'))).toBe(true)
    expect(isDraft(after('hi', '\x7f', '\x7f'))).toBe(false)
  })

  it('stops counting once the cursor moved, so backspacing no longer empties it', () => {
    expect(isDraft(after('hi', '\x1b[D', '\x7f\x7f\x7f'))).toBe(true)
  })

  it('treats a paste and a recalled history entry as a draft', () => {
    expect(isDraft(after('\x1b[200~x\x1b[201~'))).toBe(true)
    expect(isDraft(after('\x1b[A'))).toBe(true)
    expect(isDraft(after('\x1bOA'))).toBe(true)
  })

  it('empties on Enter after plain text and on Ctrl+C', () => {
    expect(isDraft(after('fix it\r'))).toBe(false)
    expect(isDraft(after('half a thought', '\x03'))).toBe(false)
  })

  it('keeps a possible picker up after a command, an @-completion or recalled history, until a choice or a cancel', () => {
    for (const keys of ['/model\r', 'look at @src\r', '\x1b[A\r']) {
      expect(isDraft(after(keys))).toBe(true)
      expect(isDraft(after(keys, 'son'))).toBe(true)
      expect(isDraft(after(keys, '\r'))).toBe(false)
      expect(isDraft(after(keys, '\x1b'))).toBe(false)
    }
  })

  it('takes Esc-Esc on an empty prompt for the rewind picker, but a single Esc for nothing', () => {
    expect(isDraft(after('\x1b'))).toBe(false)
    expect(isDraft(after('\x1b', '\x1b'))).toBe(true)
    expect(isDraft(after('\x1b\x1b', '\x1b'))).toBe(false)
  })

  it('takes other control keys on an empty prompt (Ctrl+R) for a view of their own', () => {
    expect(isDraft(after('\x12'))).toBe(true)
    expect(isDraft(after('\x12', '\x1b'))).toBe(false)
  })
})
