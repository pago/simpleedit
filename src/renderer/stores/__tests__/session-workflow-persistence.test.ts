import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { SerializedSession, WorktreeInfo } from '../../../shared/ipc-types'
import { sessionsStore } from '../sessions.svelte'
import { setProjectRoot, refreshWorktreesFor } from '../worktrees.svelte'
import { tabsStore, tabIdFor, type WorkflowTab } from '../tabsStore.svelte'
import { serializeSession, hydrateSession } from '../../lib/sessionPersistence'

const PRIMARY = '/repo/primary.git'
const MAIN_WT = '/repo/primary/main'
const WF = 'wf_abcdefgh'

const LISTS: Record<string, WorktreeInfo[]> = {
  [PRIMARY]: [{ path: MAIN_WT, branch: 'main', isMain: true, isCurrent: false }],
}

function workflowTab(): WorkflowTab {
  return { kind: 'workflow', id: tabIdFor({ kind: 'workflow', workflowId: WF }), workflowId: WF, title: 'Flow' }
}

beforeEach(async () => {
  const invoke = vi.fn((channel: string, repoPath?: string) => {
    if (channel === 'worktree:list') return Promise.resolve(LISTS[repoPath ?? PRIMARY] ?? [])
    return Promise.resolve(undefined)
  })
  ;(window as unknown as { api: { invoke: unknown } }).api = { invoke }
  setProjectRoot(PRIMARY)
  await refreshWorktreesFor(PRIMARY)
  sessionsStore.reset()
})

describe('workflow persistence', () => {
  it('a workflow tab survives a serialize → hydrate round-trip', () => {
    const id = sessionsStore.createClaude(PRIMARY, MAIN_WT)
    sessionsStore.update(id, { providerSessionId: 'uuid-lead' })
    tabsStore.open(id, workflowTab())

    const blob = serializeSession(PRIMARY)
    expect(blob.sessions[0].tabs).toEqual([{ kind: 'workflow', id: workflowTab().id, workflowId: WF, title: 'Flow' }])
    expect(blob.sessions[0].activeTabId).toBe(workflowTab().id)

    sessionsStore.reset()
    hydrateSession(blob)
    const restored = sessionsStore.sessions()[0]
    expect(tabsStore.list(restored.id)).toEqual([workflowTab()])
    expect(tabsStore.activeId(restored.id)).toBe(workflowTab().id)
  })

  it('a worker\'s workflow owner survives a serialize → hydrate round-trip', () => {
    const owner = { kind: 'workflow' as const, workflowId: WF, taskId: 'build', attempt: 2 }
    const id = sessionsStore.createAgent({ provider: 'claude' }, PRIMARY, MAIN_WT, { owner })
    sessionsStore.update(id, { providerSessionId: 'uuid-worker' })

    const blob = serializeSession(PRIMARY)
    expect(blob.sessions[0].owner).toEqual(owner)

    sessionsStore.reset()
    hydrateSession(blob)
    const restored = sessionsStore.sessions()[0]
    expect(restored.owner).toEqual(owner)
    expect(restored.pendingResume).toEqual({ sessionId: 'uuid-worker' })
    expect(sessionsStore.visibleSessions()).toEqual([])
  })

  it('drops a malformed workflow owner on hydrate', () => {
    const blob: SerializedSession = {
      version: 4,
      repoPath: PRIMARY,
      savedAt: '2026-10-16T00:00:00.000Z',
      activeIndex: null,
      sessions: [
        {
          kind: 'agent',
          label: 'worker',
          worktreePath: MAIN_WT,
          launchDir: PRIMARY,
          sessionId: 'uuid-bad',
          owner: { kind: 'workflow', workflowId: WF, taskId: 'build', attempt: 0 },
          tabs: [],
          activeTabId: null,
          unread: [],
        },
      ],
    }
    hydrateSession(blob)
    expect(sessionsStore.sessions()[0].owner).toBeUndefined()
  })
})
