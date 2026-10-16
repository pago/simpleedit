/**
 * The companion's read-only launch comes only from main's own lookup (the
 * `mainOnly` argument), never from the spawn payload: the renderer and the
 * phone send the same `agent:spawn`, and a client must not be able to turn a
 * launch into (or out of) a companion's.
 */
import { tmpdir } from 'os'
import { describe, expect, it, vi } from 'vitest'

vi.mock('node-pty', () => ({
  spawn: () => ({ cols: 80, rows: 24, write: vi.fn(), resize: vi.fn(), kill: vi.fn(), onData: () => {}, onExit: () => {} }),
}))
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/app', getPath: () => tmpdir() } }))

import type { RemoteClient } from '../client-hub'
import type { AgentSpawnOptions } from '../../shared/ipc-types'
import { registerProvider, type LaunchContext } from '../agents/provider'
import { isTerminalLive, killTerminal, spawnAgentTerminalForProvider } from '../pty'

const seen: LaunchContext[] = []
registerProvider({
  id: 'claude',
  buildLaunch: (ctx) => {
    seen.push(ctx)
    return { executable: 'true', args: [] }
  },
  capabilities: {} as never,
})

const client = { id: 1, send: () => {}, isDestroyed: () => false } as unknown as RemoteClient

describe('companion launch options', () => {
  it('ignores a reviewCompanion a client put in the payload', async () => {
    const options = {
      id: 'agent-claude-a',
      worktreePath: tmpdir(),
      target: { provider: 'claude' },
      reviewCompanion: { reviewId: 'r_review01', extraReadDir: '/' },
    } as unknown as AgentSpawnOptions
    await spawnAgentTerminalForProvider(options, client, '1')
    expect(seen.at(-1)?.reviewCompanion).toBeUndefined()
    expect(isTerminalLive('agent-claude-a')).toBe(true)
    killTerminal('agent-claude-a')
  })

  it('passes what main derived', async () => {
    const reviewCompanion = { reviewId: 'r_review01', extraReadDir: '/data/r_review01' }
    await spawnAgentTerminalForProvider(
      { id: 'agent-claude-b', worktreePath: tmpdir(), target: { provider: 'claude' } },
      client,
      '1',
      { reviewCompanion },
    )
    expect(seen.at(-1)?.reviewCompanion).toEqual(reviewCompanion)
    killTerminal('agent-claude-b')
    expect(isTerminalLive('agent-claude-b')).toBe(false)
  })
})
