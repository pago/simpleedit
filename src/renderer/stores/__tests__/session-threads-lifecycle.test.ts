import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { WorktreeInfo } from '../../../shared/ipc-types'
import { sessionsStore, initSessionListeners } from '../sessions.svelte'
import { setProjectRoot, refreshWorktreesFor } from '../worktrees.svelte'

const PRIMARY = '/repo/primary.git'
const MAIN_WT = '/repo/primary/main'
const LISTS: Record<string, WorktreeInfo[]> = {
  [PRIMARY]: [{ path: MAIN_WT, branch: 'main', isMain: true, isCurrent: false }],
}

type Handler = (data: unknown) => void
const handlers = new Map<string, Handler>()
let invoke: ReturnType<typeof vi.fn>

const ended = () => invoke.mock.calls.filter((c) => c[0] === 'agent-threads:session-ended').map((c) => c.slice(1))

beforeEach(async () => {
  handlers.clear()
  invoke = vi.fn((channel: string, arg?: unknown) => {
    if (channel === 'worktree:list') return Promise.resolve(LISTS[(arg as string) ?? PRIMARY] ?? [])
    if (channel === 'models:claude') return Promise.resolve([])
    if (channel === 'models:installed') return Promise.resolve([])
    return Promise.resolve(undefined)
  })
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    invoke,
    on: vi.fn((channel: string, handler: Handler) => {
      handlers.set(channel, handler)
      return () => handlers.delete(channel)
    }),
  }
  setProjectRoot(PRIMARY)
  await refreshWorktreesFor(PRIMARY)
  sessionsStore.reset()
})

describe('agent threads across the session lifecycle', () => {
  it('ends a removed session’s threads', () => {
    const id = sessionsStore.createClaude(PRIMARY, MAIN_WT)
    sessionsStore.remove(id)
    expect(sessionsStore.get(id)).toBeUndefined()
    expect(ended()).toEqual([[id, null]])
  })

  it('moves the threads to the successor on a hand-off', () => {
    const id = sessionsStore.createClaude(PRIMARY, MAIN_WT)
    const successor = sessionsStore.replaceWithClaude(id, PRIMARY, MAIN_WT, { initialPrompt: 'brief' })
    expect(successor).toBeTruthy()
    expect(ended()).toEqual([[id, successor]])
  })

  it('leaves threads alone when a PTY exits on its own, as it does when the app quits', () => {
    const off = initSessionListeners()
    try {
      const id = sessionsStore.createClaude(PRIMARY, MAIN_WT)
      handlers.get('pty:exit')!({ id, exitCode: 0 })
      expect(sessionsStore.get(id)).toBeUndefined()
      expect(ended()).toEqual([])
    } finally {
      off()
    }
  })
})
