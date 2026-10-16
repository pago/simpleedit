import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { WorktreeInfo } from '../../../shared/ipc-types'
import type { Review } from '../../../shared/review-room'
import { sessionsStore, initSessionListeners } from '../sessions.svelte'
import { setProjectRoot, refreshWorktreesFor } from '../worktrees.svelte'

/**
 * The renderer's half of a review companion: it is created under the id main
 * reserved, owned and never selected; Resume rebinds main's claim before it
 * spawns; and a session no claim names any more goes away.
 */

const PRIMARY = '/repo/primary.git'
const MAIN_WT = '/repo/primary/main'
const WORKTREES: WorktreeInfo[] = [{ path: MAIN_WT, branch: 'main', isMain: true, isCurrent: false }]

type Handler = (data: unknown) => void
const handlers = new Map<string, Handler>()
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

type Invoke = (channel: string, ...args: unknown[]) => unknown
let invoke: ReturnType<typeof vi.fn<Invoke>>
let rebindAnswer: boolean

function calls(channel: string): unknown[][] {
  return invoke.mock.calls.filter((call) => call[0] === channel).map((call) => call.slice(1))
}

function review(companionSessionId?: string, status: Review['status'] = 'open'): Review {
  return {
    id: 'r_review01',
    repo: 'github.com/acme/app',
    layers: [],
    status,
    ...(companionSessionId
      ? { companion: { sessionId: companionSessionId, windowId: 1, agent: { provider: 'claude', model: 'default' }, claimRequestId: 'q' } }
      : {}),
    companionAgent: { provider: 'claude', model: 'default' },
    lastSeenHead: {},
    readSteps: [],
    round: 1,
    submissions: [],
    createdAt: '',
    updatedAt: '',
  }
}

beforeEach(async () => {
  handlers.clear()
  rebindAnswer = true
  invoke = vi.fn((channel: string, arg?: unknown) => {
    if (channel === 'worktree:list') return Promise.resolve(arg === undefined || arg === PRIMARY ? WORKTREES : [])
    if (channel === 'review:companion-rebind') return Promise.resolve(rebindAnswer)
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

describe('review:companion-create-request', () => {
  it('creates the owned session under the reserved id, unselected, and answers', async () => {
    const before = sessionsStore.activeSessionId()
    const off = initSessionListeners()
    try {
      handlers.get('review:companion-create-request')!({
        correlationId: 'c1',
        reviewId: 'r_review01',
        sessionId: 'agent-claude-reserved',
        target: { provider: 'claude' },
        brief: 'You are my companion',
        label: 'Review companion · acme/app#12',
      })
      await flush()
      const session = sessionsStore.get('agent-claude-reserved')
      expect(session).toMatchObject({ owner: { kind: 'review', reviewId: 'r_review01' }, seedPrompt: 'You are my companion' })
      expect(sessionsStore.activeSessionId()).toBe(before)
      expect(calls('agent:spawn')[0]![0]).toMatchObject({ id: 'agent-claude-reserved', initialPrompt: 'You are my companion' })
      expect(calls('agent:spawn')[0]![0]).not.toHaveProperty('reviewCompanion')
      expect(calls('review:companion-created')).toEqual([['c1', { ok: true }]])
      // A companion's agent is not the user's last pick.
      expect(calls('models:config-set')).toEqual([])
    } finally {
      off()
    }
  })
})

describe('restored companion', () => {
  function restore(): string {
    return sessionsStore.addRestoredSession({
      kind: 'agent',
      provider: 'claude',
      target: { provider: 'claude' },
      label: 'Companion',
      launchDir: '/repo',
      worktreePath: MAIN_WT,
      sessionId: 'abc-123',
      owner: { kind: 'review', reviewId: 'r_review01' },
      companionClaimId: 'agent-claude-old',
    })!
  }

  it('rebinds the claim to its new id before spawning', async () => {
    const id = restore()
    sessionsStore.resumePlaceholder(id)
    await flush()
    expect(calls('review:companion-rebind')).toEqual([['r_review01', 'agent-claude-old', id]])
    expect(calls('agent:spawn')).toEqual([[expect.objectContaining({ id, resumeSessionId: 'abc-123' })]])
    expect(sessionsStore.get(id)?.companionClaimId).toBeUndefined()
  })

  it('drops the placeholder and spawns nothing when the rebind is refused', async () => {
    rebindAnswer = false
    const id = restore()
    sessionsStore.resumePlaceholder(id)
    await flush()
    expect(calls('agent:spawn')).toEqual([])
    expect(sessionsStore.get(id)).toBeUndefined()
  })

  it('goes when no claim names it any more, and stays while one does', () => {
    const id = restore()
    sessionsStore.dropUnclaimedCompanions([review('agent-claude-old')])
    expect(sessionsStore.get(id)).toBeDefined()
    sessionsStore.dropUnclaimedCompanions([review(id)])
    expect(sessionsStore.get(id)).toBeDefined()
    sessionsStore.dropUnclaimedCompanions([review('agent-claude-old', 'submitted')])
    expect(sessionsStore.get(id)).toBeUndefined()
  })
})
