import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { AgentCapabilities, AgentProviderId, ModelConfig, WorktreeInfo } from '../../../shared/ipc-types'
import { sessionsStore, initSessionListeners } from '../sessions.svelte'
import { setProjectRoot, refreshWorktreesFor } from '../worktrees.svelte'
import { initAgentCapabilities } from '../agent-capabilities.svelte'

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

/**
 * The descriptors as main registers them. `descriptor-contract.test.ts` is
 * what keeps these honest — a fixture is free to describe a world production
 * cannot produce, which is exactly how a missing `nativeModelBrand` went
 * unnoticed while every renderer test of this path stayed green.
 */
const NATIVE: AgentCapabilities = {
  status: 'precise', resume: true, fork: true, tracking: 'full', mcp: true,
  modelOverride: 'native', shiftEnter: 'native', droppedPath: 'at-reference',
  gracefulShutdown: true, displayName: 'Codex', oscTitle: 'directory',
  reportingSetup: 'user-granted', modelSelector: 'model-id', reasoningEffort: true,
  nativeModelBrand: 'openai', modelCatalog: true, reportsSessionTitle: false,
}
const CAPS: Record<string, AgentCapabilities> = {
  claude: {
    ...NATIVE, displayName: 'Claude', status: 'osc', modelOverride: 'env',
    shiftEnter: 'escape-newline', droppedPath: 'newline-list',
    oscTitle: 'session-label', reportingSetup: 'automatic',
    modelSelector: 'model-ref', reasoningEffort: false,
    nativeModelBrand: undefined, reportsSessionTitle: true,
  },
  codex: NATIVE,
  opencode: { ...NATIVE, displayName: 'OpenCode', nativeModelBrand: 'opencode', oscTitle: 'constant' },
}

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
    if (channel === 'agent:providers') return Promise.resolve(['claude', 'codex', 'opencode'] as AgentProviderId[])
    if (channel === 'agent:capabilities') return Promise.resolve(CAPS[arg as string])
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
  await initAgentCapabilities()
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

  // The remembered model is a uniform ModelRef; the agent that owns it is
  // resolved from the descriptors. Naming one brand here — `provider ===
  // 'openai'` — is what quietly sent every other native model to Claude.
  it.each([
    ['openai', 'gpt-5-codex', 'codex'],
    ['opencode', 'opencode/deepseek-v4-flash-free', 'opencode'],
  ] as const)(
    'starts the agent that owns the last-used model (%s)',
    async (brand, model, provider) => {
      config = {
        defaults: {},
        submenuAllowlist: [],
        lastUsed: { provider: brand, model, reasoningEffort: 'high' },
      }
      const off = initSessionListeners()
      try {
        handlers.get('session:create-request')!({ correlationId: 'c1', brief: 'ship it' })
        await flush()

        const started = sessionsStore.sessions()[0]
        expect(started.provider).toBe(provider)
        expect(started.target).toMatchObject({ model, reasoningEffort: 'high' })
      } finally {
        off()
      }
    },
  )

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

  it('reports a throw instead of letting main record an unwitnessed outcome', async () => {
    // The bridge throws SYNCHRONOUSLY when a payload will not structured-clone
    // — the failure `createAgent` snapshots its target to avoid. Unreported,
    // main waits out its timeout and then remembers the intent as one that may
    // have started something, so the user cannot retry what in fact failed.
    const spawnBoom = vi.fn((channel: string, ...rest: unknown[]) => {
      if (channel === 'agent:spawn') throw new Error('could not be cloned')
      return invoke(channel, ...rest)
    })
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      invoke: spawnBoom,
      on: vi.fn((channel: string, handler: Handler) => {
        handlers.set(channel, handler)
        return () => handlers.delete(channel)
      }),
    }

    const off = initSessionListeners()
    try {
      handlers.get('session:create-request')!({ correlationId: 'c1', brief: 'ship it' })
      await flush()

      const reported = spawnBoom.mock.calls
        .filter((call) => call[0] === 'session:created')
        .map((call) => call[2])
      expect(reported).toEqual([{ ok: false, reason: expect.stringContaining('cloned') }])
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
