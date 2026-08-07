/**
 * The peer set the messaging bus exposes to agents, pushed over `agent-bus:sync`.
 *
 * This is provider-agnostic by design: a Codex session must be as addressable as
 * a Claude one. The filter read `kind === 'claude'` when messaging landed, and
 * the provider refactor renamed that kind to 'agent' — leaving the peer set
 * permanently empty, so `list_sessions` returned nothing and no agent could
 * message another. Nothing caught it, because `pnpm typecheck` does not actually
 * check the renderer.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { AgentPeer, WorktreeInfo } from '../../../shared/ipc-types'
import { sessionsStore, initSessionListeners } from '../sessions.svelte'
import { setProjectRoot, refreshWorktreesFor } from '../worktrees.svelte'

const PRIMARY = '/repo/primary.git'
const ROOT = '/repo'
const MAIN_WT = '/repo/primary/main'

let invoke: ReturnType<typeof vi.fn>
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** The most recent peer list pushed to main. */
function lastSyncedPeers(): AgentPeer[] | undefined {
  const calls = invoke.mock.calls.filter(([channel]) => channel === 'agent-bus:sync')
  return calls.at(-1)?.[1] as AgentPeer[] | undefined
}

beforeEach(async () => {
  invoke = vi.fn((channel: string) => {
    if (channel === 'worktree:list') {
      return Promise.resolve<WorktreeInfo[]>([{ path: MAIN_WT, branch: 'main', isMain: true, isCurrent: false }])
    }
    if (channel === 'agent:providers') return Promise.resolve([])
    if (channel === 'models:claude') return Promise.resolve([])
    return Promise.resolve(undefined)
  })
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    invoke,
    on: vi.fn(() => () => {}),
  }
  setProjectRoot(PRIMARY)
  await refreshWorktreesFor(PRIMARY)
  sessionsStore.reset()
})

describe('agent-bus peer snapshot', () => {
  it('exposes both providers as addressable peers', async () => {
    const off = initSessionListeners()
    try {
      const claude = sessionsStore.createClaude(ROOT, MAIN_WT)
      const codex = sessionsStore.createCodex(ROOT, MAIN_WT)
      await flush()

      const peers = lastSyncedPeers() ?? []
      const ids = peers.map((p) => p.terminalId)
      expect(ids).toContain(claude)
      expect(ids).toContain(codex)
      expect(peers.find((p) => p.terminalId === codex)?.provider).toBe('codex')
      expect(peers.find((p) => p.terminalId === claude)?.provider).toBe('claude')
    } finally {
      off()
    }
  })

  it('excludes plain terminals — there is no agent behind them', async () => {
    const off = initSessionListeners()
    try {
      const term = sessionsStore.createTerminal(MAIN_WT)
      await flush()
      expect((lastSyncedPeers() ?? []).map((p) => p.terminalId)).not.toContain(term)
    } finally {
      off()
    }
  })

  it('excludes a session with no live process, so mail cannot queue undeliverably', async () => {
    const off = initSessionListeners()
    try {
      const dead = sessionsStore.createCodex(ROOT, MAIN_WT)
      sessionsStore.update(dead, { exited: { exitCode: 1 } })
      const asleep = sessionsStore.createClaude(ROOT, MAIN_WT)
      sessionsStore.update(asleep, { pendingResume: { sessionId: 'sid-1' } })
      await flush()

      const ids = (lastSyncedPeers() ?? []).map((p) => p.terminalId)
      expect(ids).not.toContain(dead)
      expect(ids).not.toContain(asleep)
    } finally {
      off()
    }
  })
})
