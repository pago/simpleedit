import { describe, it, expect } from 'vitest'
import { viewForShortcut } from '../viewShortcuts'

const key = (k: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey', boolean>> = {}) => ({
  key: k, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods,
})

describe('viewForShortcut', () => {
  it('maps ⌘1–3 and Ctrl+1–3 to the sidebar sections', () => {
    expect(viewForShortcut(key('1', { metaKey: true }))).toBe('workspace')
    expect(viewForShortcut(key('2', { metaKey: true }))).toBe('backlog')
    expect(viewForShortcut(key('3', { ctrlKey: true }))).toBe('screenprs')
  })

  it('ignores plain digits, other digits and extra modifiers', () => {
    expect(viewForShortcut(key('1'))).toBeNull()
    expect(viewForShortcut(key('4', { metaKey: true }))).toBeNull()
    expect(viewForShortcut(key('1', { metaKey: true, shiftKey: true }))).toBeNull()
    expect(viewForShortcut(key('2', { ctrlKey: true, altKey: true }))).toBeNull()
  })
})
