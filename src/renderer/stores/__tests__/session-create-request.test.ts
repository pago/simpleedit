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

type Invoke = (channel: string, ...args: unknown[]) => unknown
let invoke: ReturnType<typeof vi.fn<Invoke>>
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

  // The ✦ menu's own "New Codex session · configured default" entry starts a
  // native agent with NO model id. If that fails to record which agent ran,
  // `lastUsed` is written as undefined — an explicit clear — so using the menu
  // entry for an agent silently makes every later new-session gesture start
  // Claude instead, and the phone has no picker to correct it.
  it('remembers the agent even when the launch names no model', async () => {
    const off = initSessionListeners()
    try {
      sessionsStore.createNativeAgent('codex', PROJECT_ROOT, MAIN_WT)
      await flush()

      const remembered = invoke.mock.calls
        .filter((call) => call[0] === 'models:config-set')
        .map((call) => call[1])
      expect(remembered).toEqual([{ lastUsed: { provider: 'openai' } }])
    } finally {
      off()
    }
  })

  it('starts that same agent again from the memory it just wrote', async () => {
    const off = initSessionListeners()
    try {
      sessionsStore.createNativeAgent('codex', PROJECT_ROOT, MAIN_WT)
      await flush()
      const written = invoke.mock.calls.find((call) => call[0] === 'models:config-set')![1]
      sessionsStore.reset()

      // Round-tripped through the config rather than hand-written: this is the
      // pairing that broke, and either half alone reads as fine.
      config = { defaults: {}, submenuAllowlist: [], ...(written as { lastUsed?: ModelConfig['lastUsed'] }) }
      handlers.get('session:create-request')!({ correlationId: 'c1', brief: 'ship it' })
      await flush()
      expect(sessionsStore.sessions()[0].provider).toBe('codex')
    } finally {
      off()
    }
  })

  it('starts the agent and model a Discuss request picked, under its fixed name', async () => {
    config = { defaults: {}, submenuAllowlist: [], lastUsed: { provider: 'openai', model: 'gpt-5-codex' } }
    const off = initSessionListeners()
    try {
      handlers.get('session:create-request')!({
        correlationId: 'c1',
        brief: 'You are helping me review a GitHub pull request.',
        label: 'review acme/app#7',
        labelFixed: true,
        target: { provider: 'claude', model: { provider: 'anthropic', model: 'sonnet' } },
      })
      await flush()

      const started = sessionsStore.sessions()[0]
      // The pick wins over the remembered default.
      expect(started.provider).toBe('claude')
      expect(started.model).toEqual({ provider: 'anthropic', model: 'sonnet' })
      expect(started.seedPrompt).toBe('You are helping me review a GitHub pull request.')
      // A chosen name, as at the desk: the agent's title does not replace it.
      sessionsStore.applySessionTitle(started.id, 'Something else')
      expect(sessionsStore.get(started.id)?.label).toBe('review acme/app#7')
      expect(outcomes()).toEqual([{ ok: true, terminalId: started.id, label: 'review acme/app#7' }])
    } finally {
      off()
    }
  })

  it('starts a picked native agent', async () => {
    const off = initSessionListeners()
    try {
      handlers.get('session:create-request')!({
        correlationId: 'c1',
        brief: 'review it',
        target: { provider: 'codex', model: 'gpt-5.5' },
      })
      await flush()
      const started = sessionsStore.sessions()[0]
      expect(started.provider).toBe('codex')
      expect(started.target).toEqual({ provider: 'codex', model: 'gpt-5.5' })
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
    const spawnBoom = vi.fn<Invoke>((channel, ...rest) => {
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
