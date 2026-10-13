import { describe, it, expect } from 'vitest'
import { isToggleSidebarShortcut, loadSidebarCollapsed, saveSidebarCollapsed } from '../sidebarCollapse'

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const map = new Map<string, string>()
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) }
}

const NO_MODS = { metaKey: false, ctrlKey: false, shiftKey: false, altKey: false }

describe('sidebarCollapse', () => {
  it('remembers the collapsed state, expanded by default', () => {
    const storage = memoryStorage()
    expect(loadSidebarCollapsed(storage)).toBe(false)
    saveSidebarCollapsed(true, storage)
    expect(loadSidebarCollapsed(storage)).toBe(true)
    saveSidebarCollapsed(false, storage)
    expect(loadSidebarCollapsed(storage)).toBe(false)
  })

  it('falls back to expanded when storage throws', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
    }
    expect(loadSidebarCollapsed(broken)).toBe(false)
    expect(() => saveSidebarCollapsed(true, broken)).not.toThrow()
  })

  it('is ⌘B on macOS, never Ctrl+B there', () => {
    expect(isToggleSidebarShortcut({ ...NO_MODS, key: 'b', metaKey: true }, true, false)).toBe(true)
    expect(isToggleSidebarShortcut({ ...NO_MODS, key: 'b', metaKey: true }, true, true)).toBe(true)
    expect(isToggleSidebarShortcut({ ...NO_MODS, key: 'b', ctrlKey: true }, true, false)).toBe(false)
    expect(isToggleSidebarShortcut({ ...NO_MODS, key: 'b', metaKey: true, shiftKey: true }, true, false)).toBe(false)
  })

  it('is Ctrl+B elsewhere, except in a terminal, where it belongs to readline and tmux', () => {
    expect(isToggleSidebarShortcut({ ...NO_MODS, key: 'b', ctrlKey: true }, false, false)).toBe(true)
    expect(isToggleSidebarShortcut({ ...NO_MODS, key: 'B', ctrlKey: true }, false, false)).toBe(true)
    expect(isToggleSidebarShortcut({ ...NO_MODS, key: 'b', ctrlKey: true }, false, true)).toBe(false)
    expect(isToggleSidebarShortcut({ ...NO_MODS, key: 'b', metaKey: true }, false, false)).toBe(false)
  })
})
