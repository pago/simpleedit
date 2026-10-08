import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { MemoryLocation } from '../../../shared/ipc-types'
import { sessionsStore, viewRootFor } from '../sessions.svelte'
import { tabsStore, tabIdFor, type FileTab } from '../tabsStore.svelte'
import { openDiffTab } from '../diffReview.svelte'
import { serializeSession } from '../../lib/sessionPersistence'

const MEMORY = '/home/u/.claude/projects/-proj/memory'
const WORKTREE = '/proj/main'

let location: MemoryLocation

function fileTab(path: string, modified = false): FileTab {
  return { kind: 'file', id: tabIdFor({ kind: 'file', path }), path, modified }
}

function createAgentSession(): string {
  const id = sessionsStore.createAgent({ provider: 'claude' }, '/proj', WORKTREE)
  sessionsStore.select(id)
  return id
}

beforeEach(() => {
  location = { memoryDir: MEMORY, exists: true, git: null }
  vi.stubGlobal('api', {
    invoke: vi.fn((channel: string) => {
      if (channel === 'memory:resolve') return Promise.resolve(location)
      return Promise.resolve(undefined)
    }),
    on: vi.fn(() => () => {}),
  })
  sessionsStore.reset()
})

describe('memory view on a session', () => {
  it('opens over the worktree without touching worktreePath', async () => {
    const id = createAgentSession()
    await sessionsStore.openMemoryView(id)
    const s = sessionsStore.get(id)!
    expect(s.worktreePath).toBe(WORKTREE)
    expect(s.memoryView?.memoryDir).toBe(MEMORY)
    expect(s.viewerOpen).toBe(true)
    expect(viewRootFor(s)).toBe(MEMORY)
  })

  it('Back closes memory tabs and restores a closed viewer', async () => {
    const id = createAgentSession()
    expect(sessionsStore.get(id)!.viewerOpen).toBeFalsy()
    await sessionsStore.openMemoryView(id)
    tabsStore.open(id, fileTab(`${MEMORY}/MEMORY.md`))
    openDiffTab(id, '/home/u/.claude', 'abc', 'msg', { memoryScope: { pathspec: 'projects/-proj/memory' } })
    tabsStore.open(id, fileTab(`${WORKTREE}/src/a.ts`))

    expect(sessionsStore.closeMemoryView(id)).toEqual({ blocked: [] })

    const s = sessionsStore.get(id)!
    expect(s.memoryView).toBeUndefined()
    expect(s.viewerOpen).toBe(false)
    expect(viewRootFor(s)).toBe(WORKTREE)
    expect(tabsStore.list(id).map((t) => t.id)).toEqual([tabIdFor({ kind: 'file', path: `${WORKTREE}/src/a.ts` })])
  })

  it('a dirty memory tab blocks Back and leaves everything in place', async () => {
    const id = createAgentSession()
    await sessionsStore.openMemoryView(id)
    tabsStore.open(id, fileTab(`${MEMORY}/note.md`, true))

    expect(sessionsStore.closeMemoryView(id)).toEqual({ blocked: [`${MEMORY}/note.md`] })

    const s = sessionsStore.get(id)!
    expect(s.memoryView?.memoryDir).toBe(MEMORY)
    expect(s.viewerOpen).toBe(true)
    expect(tabsStore.list(id)).toHaveLength(1)
  })

  it('a dirty memory tab blocks a repo-picker repoint and records the notice', async () => {
    const id = createAgentSession()
    await sessionsStore.openMemoryView(id)
    tabsStore.open(id, fileTab(`${MEMORY}/note.md`, true))

    const ran = sessionsStore.leaveMemoryThen(id, () => sessionsStore.setActiveSessionWorktree('/proj/other'))

    expect(ran).toBe(false)
    const s = sessionsStore.get(id)!
    expect(s.worktreePath).toBe(WORKTREE)
    expect(s.memoryView?.leaveBlocked).toEqual({ files: [`${MEMORY}/note.md`], agentRepoint: false })
  })

  it('a clean leave runs the repoint after closing the memory view', async () => {
    const id = createAgentSession()
    await sessionsStore.openMemoryView(id)
    tabsStore.open(id, fileTab(`${MEMORY}/note.md`))

    const ran = sessionsStore.leaveMemoryThen(id, () => sessionsStore.setActiveSessionWorktree('/proj/other'))

    expect(ran).toBe(true)
    const s = sessionsStore.get(id)!
    expect(s.worktreePath).toBe('/proj/other')
    expect(s.memoryView).toBeUndefined()
    expect(tabsStore.list(id)).toHaveLength(0)
  })

  it('setActiveSessionWorktree alone leaves the memory view alone', async () => {
    const id = createAgentSession()
    await sessionsStore.openMemoryView(id)
    sessionsStore.setActiveSessionWorktree('/proj/other')
    expect(sessionsStore.get(id)!.memoryView?.memoryDir).toBe(MEMORY)
  })

  it('re-resolve updates exists/git on views from the same launch dir', async () => {
    const id = createAgentSession()
    location = { memoryDir: MEMORY, exists: false, git: null }
    await sessionsStore.openMemoryView(id)
    sessionsStore.applyMemoryLocation('/proj', { memoryDir: MEMORY, exists: true, git: { root: '/home/u/.claude', pathspec: 'projects/-proj/memory' } })
    const mv = sessionsStore.get(id)!.memoryView!
    expect(mv.exists).toBe(true)
    expect(mv.git?.pathspec).toBe('projects/-proj/memory')
  })

  it('carries a refused dir through open and re-resolve, and clears it once allowed', async () => {
    const id = createAgentSession()
    location = { memoryDir: '/', exists: false, git: null, refused: true }
    await sessionsStore.openMemoryView(id)
    expect(sessionsStore.get(id)!.memoryView).toMatchObject({ memoryDir: '/', exists: false, refused: true })

    sessionsStore.applyMemoryLocation('/proj', { memoryDir: MEMORY, exists: true, git: null })
    const mv = sessionsStore.get(id)!.memoryView!
    expect(mv.refused).toBeUndefined()
    expect(mv.memoryDir).toBe(MEMORY)
  })

  it('memory file and memory diff tabs are never serialized', async () => {
    const id = createAgentSession()
    sessionsStore.update(id, { providerSessionId: 'uuid-1' })
    await sessionsStore.openMemoryView(id)
    tabsStore.open(id, fileTab(`${MEMORY}/MEMORY.md`))
    openDiffTab(id, '/home/u/.claude', 'abc', 'msg', { memoryScope: { pathspec: null } })
    tabsStore.open(id, fileTab(`${WORKTREE}/src/a.ts`))

    const saved = serializeSession('/proj/repo.git')
    expect(saved.sessions[0]!.tabs.map((t) => t.id)).toEqual([tabIdFor({ kind: 'file', path: `${WORKTREE}/src/a.ts` })])
  })

  it('scoped and unscoped diffs of one commit get distinct tab ids', () => {
    const scoped = tabIdFor({ kind: 'diff', worktreePath: '/r', commitHash: 'abc', memoryScope: { pathspec: 'm' } })
    const plain = tabIdFor({ kind: 'diff', worktreePath: '/r', commitHash: 'abc' })
    expect(scoped).not.toBe(plain)
  })
})
