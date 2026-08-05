import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { WorktreeInfo } from '../../../shared/ipc-types'
import { sessionsStore } from '../sessions.svelte'
import { setProjectRoot, refreshWorktreesFor } from '../worktrees.svelte'
import { serializeSession, hydrateSession } from '../../lib/sessionPersistence'

const PRIMARY = '/repo/primary.git'
const MAIN_WT = '/repo/primary/main'

const LISTS: Record<string, WorktreeInfo[]> = {
  [PRIMARY]: [{ path: MAIN_WT, branch: 'main', isMain: true, isCurrent: false }],
}

let invoke: ReturnType<typeof vi.fn>

beforeEach(async () => {
  invoke = vi.fn((channel: string, repoPath?: string) => {
    if (channel === 'worktree:list') return Promise.resolve(LISTS[repoPath ?? PRIMARY] ?? [])
    return Promise.resolve(undefined)
  })
  ;(window as unknown as { api: { invoke: unknown } }).api = { invoke }
  setProjectRoot(PRIMARY)
  await refreshWorktreesFor(PRIMARY)
  sessionsStore.reset()
})

describe('createClaude seed prompt', () => {
  it('records the initialPrompt on the session as seedPrompt', () => {
    const id = sessionsStore.createClaude(PRIMARY, MAIN_WT, { initialPrompt: 'fix the timeline reducer' })
    expect(sessionsStore.get(id)?.seedPrompt).toBe('fix the timeline reducer')
  })

  it('still forwards the prompt to the PTY spawn as initialPrompt', () => {
    sessionsStore.createClaude(PRIMARY, MAIN_WT, { initialPrompt: 'fix the timeline reducer' })
    const spawn = invoke.mock.calls.find(([channel]) => channel === 'agent:spawn')
    expect(spawn?.[1]).toMatchObject({ initialPrompt: 'fix the timeline reducer' })
  })

  it('leaves seedPrompt unset when launched without an initialPrompt', () => {
    const id = sessionsStore.createClaude(PRIMARY, MAIN_WT)
    expect(sessionsStore.get(id)?.seedPrompt).toBeUndefined()
  })
})

describe('seed prompt persistence', () => {
  it('survives a serialize → hydrate round-trip on the restored placeholder', () => {
    const id = sessionsStore.createClaude(PRIMARY, MAIN_WT, { initialPrompt: 'rebase the PR and land it' })
    // An agent session is only persistable once its provider identity is known.
    sessionsStore.update(id, { providerSessionId: 'uuid-1' })

    const blob = serializeSession(PRIMARY)
    expect(blob.sessions[0].seedPrompt).toBe('rebase the PR and land it')

    sessionsStore.reset()
    hydrateSession(blob)
    expect(sessionsStore.sessions()[0].seedPrompt).toBe('rebase the PR and land it')
  })

  it('is evicted from the persisted blob once its session is closed', () => {
    const id = sessionsStore.createClaude(PRIMARY, MAIN_WT, { initialPrompt: 'the goal' })
    sessionsStore.update(id, { providerSessionId: 'uuid-1' })
    expect(serializeSession(PRIMARY).sessions).toHaveLength(1)

    sessionsStore.close(id)
    // The blob rebuilds from live sessions, so the closed session — and its
    // seed prompt — is gone; nothing lingers past the session's lifetime.
    expect(serializeSession(PRIMARY).sessions).toHaveLength(0)
  })
})
