import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { search, executeItem } from '../palette-engine'
import { pendingPaletteAction, consumePaletteAction } from '../../../stores/commandPalette.svelte'

let invoke: ReturnType<typeof vi.fn>

beforeEach(() => {
  invoke = vi.fn((channel: string) => {
    if (channel === 'fs:list-all') return Promise.resolve(['src/a.ts'])
    if (channel === 'memory:list-files') return Promise.resolve(['MEMORY.md', 'notes/b.md'])
    if (channel === 'git:log') return Promise.reject(new Error('not a git repository'))
    return Promise.resolve([])
  })
  vi.stubGlobal('api', { invoke, on: vi.fn(() => () => {}) })
})

afterEach(() => {
  consumePaletteAction()
  vi.unstubAllGlobals()
})

describe('palette engine', () => {
  it('keeps the other providers when one rejects', async () => {
    const results = await search('', { activeSessionId: 's', worktreePath: '/wt-reject' })
    expect(results.groups.map((g) => g.category)).toContain('file')
    expect(results.flat.some((i) => i.label === 'a.ts')).toBe(true)
  })

  it('lists memory files and skips git providers in memory mode', async () => {
    const ctx = { activeSessionId: 's', worktreePath: '/wt', memory: { dir: '/mem', git: null } }
    const results = await search('', ctx)
    expect(results.groups.map((g) => g.category)).not.toContain('commit')
    expect(results.groups.map((g) => g.category)).not.toContain('action')
    expect(results.flat.map((i) => i.label)).toEqual(expect.arrayContaining(['MEMORY.md', 'b.md']))
    expect(invoke).not.toHaveBeenCalledWith('git:log', expect.anything(), expect.anything())

    expect(await search('#', ctx)).toEqual({ groups: [], flat: [] })
    expect(await search('>', ctx)).toEqual({ groups: [], flat: [] })
  })

  it('opens a memory file at its absolute path', async () => {
    const ctx = { activeSessionId: 's', worktreePath: '/wt', memory: { dir: '/mem2', git: null } }
    const results = await search('b.md', ctx)
    const item = results.flat.find((i) => i.label === 'b.md')!
    executeItem(item, ctx)
    expect(pendingPaletteAction()).toEqual({ type: 'open-file', workspaceKey: 's', filePath: '/mem2/notes/b.md' })
  })
})
