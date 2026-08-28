import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ModelConfig, WorktreeInfo } from '../../../shared/ipc-types'
import { sessionsStore, initSessionListeners } from '../sessions.svelte'
import { setProjectRoot, refreshWorktreesFor } from '../worktrees.svelte'

/**
 * The renderer's half of starting a session from the phone.
 *
 * Two things are load-bearing here and neither is visible from main: that the
 * new session gets the SAME default a new session gets at the desk, and that
 * every path answers `session:created` — main cannot distinguish a refusal
 * from silence, and it remembers silence as "a session may exist", which would
 * leave the user unable to retry an intent that started nothing.
 */

const PRIMARY = '/repo/primary.git'
const PROJECT_ROOT = '/repo'
const MAIN_WT = '/repo/primary/main'

const MAIN_ONLY: WorktreeInfo[] = [{ path: MAIN_WT, branch: 'main', isMain: true, isCurrent: false }]

type Handler = (data: unknown) => void
const handlers = new Map<string, Handler>()
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

let invoke: ReturnType<typeof vi.fn>
let config: ModelConfig | null
let worktrees: WorktreeInfo[]

/** What the renderer reported back for a correlation id, if anything. */
function outcomes(): unknown[] {
  return invoke.mock.calls.filter((call) => call[0] === 'session:created').map((call) => call[2])
}

beforeEach(async () => {
  handlers.clear()
  config = { defaults: {}, submenuAllowlist: [] }
  worktrees = MAIN_ONLY
  invoke = vi.fn((channel: string, arg?: unknown) => {
    if (channel === 'worktree:list') return Promise.resolve(arg === undefined || arg === PRIMARY ? worktrees : [])
    if (channel === 'models:config-get') {
      return config ? Promise.resolve(config) : Promise.reject(new Error('no config'))
    }
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

describe('session:create-request listener', () => {
  it('starts a session seeded with the brief and named by the label main derived', async () => {
    const off = initSessionListeners()
    try {
      handlers.get('session:create-request')!({
        correlationId: 'c1',
        brief: 'Rework the notification debounce so a flapping session buzzes once',
        label: 'Rework the notification debounce',
      })
      await flush()

      const started = sessionsStore.sessions()[0]
      expect(started.kind).toBe('agent')
      expect(started.provider).toBe('claude')
      expect(started.seedPrompt).toBe(
        'Rework the notification debounce so a flapping session buzzes once',
      )
      expect(started.label).toBe('Rework the notification debounce')
      // Agents launch at the project root and make their own worktrees, which
      // is why the phone needs no picker at all.
      expect(started.launchDir).toBe(PROJECT_ROOT)
      expect(started.worktreePath).toBe(MAIN_WT)

      expect(outcomes()).toEqual([{ ok: true, terminalId: started.id, label: started.label }])
    } finally {
      off()
    }
  })

  it('lets the agent rename what the brief provisionally called it', async () => {
    const off = initSessionListeners()
    try {
      handlers.get('session:create-request')!({
        correlationId: 'c1',
        brief: 'Rework the notification debounce so a flapping session buzzes once',
        label: 'Rework the notification debounce',
      })
      await flush()
      const started = sessionsStore.sessions()[0]

      // A first clause is a stand-in, not a choice. Treating it as one froze
      // every phone-started session at a machine-derived substring for its
      // whole life — and diverged from ⌘T, where the same session does get
      // renamed.
      sessionsStore.applySessionTitle(started.id, 'Debounce the waiting buzz')
      expect(sessionsStore.get(started.id)?.label).toBe('Debounce the waiting buzz')
    } finally {
      off()
    }
  })

  it('uses the last-used provider, so the phone matches ⌘T without offering a picker', async () => {
    config = {
      defaults: {},
      submenuAllowlist: [],
      lastUsed: { provider: 'openai', model: 'gpt-5-codex', reasoningEffort: 'high' },
    }
    const off = initSessionListeners()
    try {
      handlers.get('session:create-request')!({ correlationId: 'c1', brief: 'ship it' })
      await flush()

      const started = sessionsStore.sessions()[0]
      expect(started.provider).toBe('codex')
      expect(started.target).toMatchObject({ model: 'gpt-5-codex', reasoningEffort: 'high' })
    } finally {
      off()
    }
  })

  it('still starts a session when the model config cannot be read', async () => {
    config = null
    const off = initSessionListeners()
    try {
      handlers.get('session:create-request')!({ correlationId: 'c1', brief: 'ship it' })
      await flush()

      expect(sessionsStore.sessions()).toHaveLength(1)
      expect(outcomes()).toHaveLength(1)
    } finally {
      off()
    }
  })

  it('reports a refusal rather than leaving main to time out', async () => {
    // A window with nothing open: nowhere to launch. Main must be able to tell
    // this apart from silence, because it remembers silence as "a session may
    // exist" and would then refuse to retry an intent that started nothing.
    worktrees = []
    await refreshWorktreesFor(PRIMARY)
    setProjectRoot(null)
    const off = initSessionListeners()
    try {
      handlers.get('session:create-request')!({ correlationId: 'c1', brief: 'ship it' })
      await flush()

      expect(sessionsStore.sessions()).toHaveLength(0)
      expect(outcomes()).toEqual([{ ok: false, reason: expect.stringContaining('no repo') }])
    } finally {
      off()
    }
  })
})
