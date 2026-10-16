import { render } from '@testing-library/svelte'
import { describe, it, expect } from 'vitest'
import { sidebarShortcutsBlocked, viewForShortcut } from '../viewShortcuts'
import PromptModal from '../../components/PromptModal.svelte'

const key = (k: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey', boolean>> = {}) => ({
  key: k, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods,
})

describe('viewForShortcut', () => {
  it('maps ⌘1–3 on macOS, and only ⌘: Ctrl+digits stay with terminal programs', () => {
    expect(viewForShortcut(key('1', { metaKey: true }), true)).toBe('workspace')
    expect(viewForShortcut(key('2', { metaKey: true }), true)).toBe('backlog')
    expect(viewForShortcut(key('3', { metaKey: true }), true)).toBe('screenprs')
    expect(viewForShortcut(key('2', { ctrlKey: true }), true)).toBeNull()
    expect(viewForShortcut(key('2', { ctrlKey: true, metaKey: true }), true)).toBeNull()
  })

  it('maps Ctrl+1–3 elsewhere, and only Ctrl', () => {
    expect(viewForShortcut(key('1', { ctrlKey: true }), false)).toBe('workspace')
    expect(viewForShortcut(key('3', { ctrlKey: true }), false)).toBe('screenprs')
    expect(viewForShortcut(key('1', { metaKey: true }), false)).toBeNull()
  })

  it('ignores plain digits, other digits and extra modifiers', () => {
    expect(viewForShortcut(key('1'), true)).toBeNull()
    expect(viewForShortcut(key('4', { metaKey: true }), true)).toBeNull()
    expect(viewForShortcut(key('1', { metaKey: true, shiftKey: true }), true)).toBeNull()
    expect(viewForShortcut(key('2', { ctrlKey: true, altKey: true }), false)).toBeNull()
  })
})

describe('sidebarShortcutsBlocked', () => {
  it('lets the shortcut through with nothing open', () => {
    expect(sidebarShortcutsBlocked({ defaultPrevented: false })).toBe(false)
  })

  it('waits when something already handled the key', () => {
    expect(sidebarShortcutsBlocked({ defaultPrevented: true })).toBe(true)
  })

  it('waits while a modal is open, so switching sections cannot unmount it', () => {
    render(PromptModal, { title: 'Rename session', onsubmit: () => {}, oncancel: () => {} })
    expect(sidebarShortcutsBlocked({ defaultPrevented: false })).toBe(true)
  })

  it('does not count a modal left open in a hidden session workspace', () => {
    const hidden = document.createElement('div')
    hidden.className = 'hidden'
    hidden.style.display = 'none'
    const el = document.createElement('div')
    el.setAttribute('aria-modal', 'true')
    hidden.append(el)
    document.body.append(hidden)
    expect(sidebarShortcutsBlocked({ defaultPrevented: false })).toBe(false)
    hidden.remove()
  })

  it('does not count a non-modal dialog, such as the rail overlay', () => {
    const el = document.createElement('div')
    el.setAttribute('role', 'dialog')
    el.setAttribute('aria-modal', 'false')
    document.body.append(el)
    expect(sidebarShortcutsBlocked({ defaultPrevented: false })).toBe(false)
    el.remove()
  })
})
