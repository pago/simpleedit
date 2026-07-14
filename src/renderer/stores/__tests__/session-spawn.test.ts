import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { WorktreeInfo } from '../../../shared/ipc-types'
import { sessionsStore, initSessionListeners } from '../sessions.svelte'
import { setProjectRoot, refreshWorktreesFor } from '../worktrees.svelte'

const PRIMARY = '/repo/primary.git'
const PROJECT_ROOT = '/repo' // dirname of the bare repo — where Claude sessions launch
const MAIN_WT = '/repo/primary/main'
const FEAT_WT = '/repo/primary/feat'

const LISTS: Record<string, WorktreeInfo[]> = {
  [PRIMARY]: [
    { path: MAIN_WT, branch: 'main', isMain: true, isCurrent: false },
    { path: FEAT_WT, branch: 'feat', isMain: false, isCurrent: false },
  ],
}

type Handler = (data: unknown) => void
const handlers = new Map<string, Handler>()

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

beforeEach(async () => {
  handlers.clear()
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    invoke: vi.fn((channel: string, arg?: unknown) => {
      if (channel === 'worktree:list') return Promise.resolve(LISTS[(arg as string) ?? PRIMARY] ?? [])
      if (channel === 'models:claude')
        return Promise.resolve([{ provider: 'anthropic', displayName: 'Opus', model: 'claude-opus-4-8' }])
      if (channel === 'models:installed') return Promise.resolve([])
      return Promise.resolve(undefined)
    }),
    on: vi.fn((channel: string, handler: Handler) => {
      handlers.set(channel, handler)
      return () => handlers.delete(channel)
    }),
  }
  setProjectRoot(PRIMARY)
  await refreshWorktreesFor(PRIMARY)
  sessionsStore.reset()
})

describe('agent-session:spawn listener', () => {
  it('creates a fresh Claude session seeded with the brief, at the project root', async () => {
    const off = initSessionListeners()
    try {
      handlers.get('agent-session:spawn')!({ sourceTerminalId: 'nobody', brief: 'fix the timeline reducer' })
      await flush()

      const spawned = sessionsStore.sessions()[0]
      expect(spawned.kind).toBe('claude')
      expect(spawned.seedPrompt).toBe('fix the timeline reducer')
      expect(spawned.launchDir).toBe(PROJECT_ROOT)
      // No caller and no explicit worktree → default to the main worktree.
      expect(spawned.worktreePath).toBe(MAIN_WT)
    } finally {
      off()
    }
  })

  it('does not disturb the caller session (fan-out: caller keeps running)', async () => {
    const off = initSessionListeners()
    try {
      const callerId = sessionsStore.createClaude(PRIMARY, FEAT_WT)
      handlers.get('agent-session:spawn')!({ sourceTerminalId: callerId, brief: 'do the thing' })
      await flush()

      expect(sessionsStore.get(callerId)).toBeDefined()
      expect(sessionsStore.sessions()).toHaveLength(2)
    } finally {
      off()
    }
  })

  it("inherits the caller's worktree and model when neither is overridden", async () => {
    const off = initSessionListeners()
    try {
      const callerId = sessionsStore.createClaude(PRIMARY, FEAT_WT, {
        model: { provider: 'anthropic', model: 'claude-opus-4-8' },
      })
      handlers.get('agent-session:spawn')!({ sourceTerminalId: callerId, brief: 'continue' })
      await flush()

      const spawned = sessionsStore.sessions()[0]
      expect(spawned.id).not.toBe(callerId)
      expect(spawned.worktreePath).toBe(FEAT_WT)
      expect(spawned.model).toEqual({ provider: 'anthropic', model: 'claude-opus-4-8' })
    } finally {
      off()
    }
  })

  it('resolves an explicit model id override via the agent-model catalog', async () => {
    const off = initSessionListeners()
    try {
      handlers.get('agent-session:spawn')!({
        sourceTerminalId: 'nobody',
        brief: 'x',
        model: 'claude-opus-4-8',
        label: 'my label',
      })
      await flush()

      const spawned = sessionsStore.sessions()[0]
      expect(spawned.label).toBe('my label')
      expect(spawned.model).toEqual({ provider: 'anthropic', model: 'claude-opus-4-8' })
    } finally {
      off()
    }
  })

  it("target:'replace' disposes the caller and lands the successor in its slot", async () => {
    const off = initSessionListeners()
    try {
      const other = sessionsStore.createClaude(PRIMARY, MAIN_WT) // pos 0 after prepend
      const callerId = sessionsStore.createClaude(PRIMARY, FEAT_WT) // now pos 0, other pos 1
      const callerIndex = sessionsStore.sessions().findIndex((s) => s.id === callerId)

      handlers.get('agent-session:spawn')!({
        sourceTerminalId: callerId,
        brief: 'reset onto fresh context',
        target: 'replace',
      })
      await flush()

      // Caller is gone; total count unchanged (one replaced by one).
      expect(sessionsStore.get(callerId)).toBeUndefined()
      expect(sessionsStore.sessions()).toHaveLength(2)
      expect(sessionsStore.get(other)).toBeDefined()

      // Successor took the caller's slot, seeded with the brief, at its worktree.
      const successor = sessionsStore.sessions()[callerIndex]
      expect(successor.id).not.toBe(callerId)
      expect(successor.seedPrompt).toBe('reset onto fresh context')
      expect(successor.worktreePath).toBe(FEAT_WT)
      // It becomes the active session (you land on the fresh session).
      expect(sessionsStore.activeSessionId()).toBe(successor.id)
    } finally {
      off()
    }
  })

  it("falls back to new-pane when target:'replace' names an unknown caller", async () => {
    const off = initSessionListeners()
    try {
      handlers.get('agent-session:spawn')!({ sourceTerminalId: 'ghost', brief: 'x', target: 'replace' })
      await flush()
      expect(sessionsStore.sessions()).toHaveLength(1)
      expect(sessionsStore.sessions()[0].seedPrompt).toBe('x')
    } finally {
      off()
    }
  })
})

describe('replaceWithClaude (store)', () => {
  it('preserves the outgoing session group across the swap', () => {
    const a = sessionsStore.createClaude(PRIMARY, MAIN_WT)
    const b = sessionsStore.createClaude(PRIMARY, FEAT_WT)
    const g = sessionsStore.createGroup([a, b])!
    expect(g).toBeTruthy()

    const newId = sessionsStore.replaceWithClaude(a, PRIMARY, MAIN_WT, { initialPrompt: 'fresh' })
    expect(newId).toBeTruthy()
    expect(sessionsStore.get(a)).toBeUndefined()

    // The group survives (still ≥2 members) and the successor joined it.
    expect(sessionsStore.group(g)).toBeDefined()
    expect(sessionsStore.get(newId!)?.groupId).toBe(g)
    expect(sessionsStore.get(b)?.groupId).toBe(g)
  })

  it('returns null for an unknown outgoing session', () => {
    expect(sessionsStore.replaceWithClaude('ghost', PRIMARY, MAIN_WT)).toBeNull()
  })
})

describe('forkClaude (store)', () => {
  it('forks a live session with --fork-session and groups the pair', () => {
    const src = sessionsStore.createClaude(PRIMARY, FEAT_WT)
    sessionsStore.update(src, { claudeSessionId: 'src-uuid' })

    const forkId = sessionsStore.forkClaude(src)
    expect(forkId).toBeTruthy()

    // Fork went through claude:spawn with resume+forkSession (not a plain resume).
    const invoke = (window as unknown as { api: { invoke: { mock: { calls: unknown[][] } } } }).api.invoke
    const spawn = invoke.mock.calls.find(
      ([channel, opts]) => channel === 'claude:spawn' && (opts as { id: string }).id === forkId,
    )
    expect(spawn?.[1]).toMatchObject({ resumeSessionId: 'src-uuid', forkSession: true })

    // Origin + fork are paired in a group, both at the source's launch/worktree.
    const source = sessionsStore.get(src)!
    const fork = sessionsStore.get(forkId!)!
    expect(fork.groupId).toBeTruthy()
    expect(fork.groupId).toBe(source.groupId)
    expect(fork.launchDir).toBe(PRIMARY)
    expect(fork.worktreePath).toBe(FEAT_WT)
  })

  it('joins the source group when it already has one', () => {
    const a = sessionsStore.createClaude(PRIMARY, MAIN_WT)
    sessionsStore.update(a, { claudeSessionId: 'a-uuid' })
    const b = sessionsStore.createClaude(PRIMARY, MAIN_WT)
    const g = sessionsStore.createGroup([a, b])!

    const forkId = sessionsStore.forkClaude(a)
    expect(sessionsStore.get(forkId!)?.groupId).toBe(g)
    // No spurious extra group was formed.
    expect(sessionsStore.groups()).toHaveLength(1)
  })

  it('refuses to fork a session with no captured claude session id', () => {
    const src = sessionsStore.createClaude(PRIMARY, MAIN_WT) // no claudeSessionId yet
    expect(sessionsStore.forkClaude(src)).toBeNull()
  })
})
