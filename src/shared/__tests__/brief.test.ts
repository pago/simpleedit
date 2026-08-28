import { describe, it, expect } from 'vitest'
import { labelFromBrief, briefNudge, wordCount } from '../brief'

describe('labelFromBrief', () => {
  it('takes the first clause', () => {
    expect(labelFromBrief('Fix the timeline reducer. It drops the last event.')).toBe(
      'Fix the timeline reducer',
    )
    expect(labelFromBrief('Rebase the branch, then push it')).toBe('Rebase the branch')
  })

  it('keeps a file path whole', () => {
    // The dots and colon in a path are not clause breaks; cutting here would
    // name the session after half a filename.
    expect(labelFromBrief('Look at src/main/pty.ts:308 and say why')).toBe(
      'Look at src/main/pty.ts:308 and say why',
    )
  })

  it('collapses dictated whitespace', () => {
    expect(labelFromBrief('  add   a\n changeset ')).toBe('add a changeset')
  })

  it('truncates a long clause on a word boundary', () => {
    const label = labelFromBrief(
      'Rework the notification debounce so a session that flaps between running and waiting only buzzes once',
    )
    expect(label).not.toBeNull()
    expect(label!.length).toBeLessThanOrEqual(43)
    expect(label!.endsWith('…')).toBe(true)
    expect(label).not.toMatch(/ …$/)
  })

  it('hard-cuts a single unbroken token rather than returning almost nothing', () => {
    const label = labelFromBrief(`${'x'.repeat(80)} tail`)
    expect(label).toBe(`${'x'.repeat(42)}…`)
  })

  it('never cuts a character in half', () => {
    // Astral characters are two UTF-16 units each, so a length-based slice can
    // land between the halves of one and emit a lone surrogate — an unpaired
    // code unit that renders as a replacement glyph in the sidebar.
    // An odd leading character puts the cut boundary INSIDE a surrogate pair.
    const label = labelFromBrief(`x${'🙂'.repeat(60)}`)
    expect(label).not.toBeNull()
    expect(label).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
    expect(label).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
    // And the budget is counted in characters, not code units, so a label of
    // astral characters is not silently half the length of an ASCII one.
    expect([...label!].length).toBe(43)
  })

  it('is null when there is nothing to name', () => {
    expect(labelFromBrief('   \n  ')).toBeNull()
    expect(labelFromBrief('')).toBeNull()
  })

  it('falls back to the whole brief when it opens with punctuation', () => {
    expect(labelFromBrief('. fix it')).toBe('. fix it')
  })
})

describe('briefNudge', () => {
  it('says nothing about an empty field', () => {
    expect(briefNudge('')).toBeNull()
  })

  it('nudges a thin brief', () => {
    expect(briefNudge('fix the tests')).toMatch(/Thin brief/)
  })

  it('stays quiet once the brief carries what, where and how to check', () => {
    expect(
      briefNudge(
        'The mobile session list shows every session as freshly blocked; make statusSince survive a reconnect and check it against the desktop sidebar.',
      ),
    ).toBeNull()
  })
})

describe('wordCount', () => {
  it('ignores dictation whitespace', () => {
    expect(wordCount('  one\n two   three ')).toBe(3)
  })
})
