import { describe, it, expect } from 'vitest'
import { clampSidebarWidth, loadSidebarWidths, saveSidebarWidth } from '../sidebarWidth'

function memoryStorage(seed: Record<string, string> = {}): Pick<Storage, 'getItem' | 'setItem'> & { data: Record<string, string> } {
  const data = { ...seed }
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v
    },
  }
}

const throwing: Pick<Storage, 'getItem' | 'setItem'> = {
  getItem: () => {
    throw new Error('blocked')
  },
  setItem: () => {
    throw new Error('blocked')
  },
}

describe('sidebar width per section', () => {
  it("opens each section at its list's old column width", () => {
    expect(loadSidebarWidths(memoryStorage())).toEqual({ workspace: 260, backlog: 340, screenprs: 380 })
  })

  it('remembers each section on its own', () => {
    const storage = memoryStorage()
    saveSidebarWidth('backlog', 300, storage)
    saveSidebarWidth('screenprs', 420, storage)
    expect(loadSidebarWidths(storage)).toEqual({ workspace: 260, backlog: 300, screenprs: 420 })
  })

  it('clamps to 180–500, on save and on load', () => {
    expect(clampSidebarWidth(20)).toBe(180)
    expect(clampSidebarWidth(9000)).toBe(500)
    const storage = memoryStorage({ 'simpleedit:sidebarWidth:workspace': '1200' })
    saveSidebarWidth('backlog', 12, storage)
    expect(storage.data['simpleedit:sidebarWidth:backlog']).toBe('180')
    expect(loadSidebarWidths(storage).workspace).toBe(500)
  })

  it('falls back to the default for junk or unavailable storage', () => {
    expect(loadSidebarWidths(memoryStorage({ 'simpleedit:sidebarWidth:backlog': 'wide' })).backlog).toBe(340)
    expect(loadSidebarWidths(throwing)).toEqual({ workspace: 260, backlog: 340, screenprs: 380 })
    expect(() => saveSidebarWidth('workspace', 300, throwing)).not.toThrow()
  })
})
