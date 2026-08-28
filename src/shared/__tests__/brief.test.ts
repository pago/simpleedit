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
