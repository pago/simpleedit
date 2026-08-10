/**
 * Provider parity: Claude, Codex and OpenCode must behave identically except
 * where a capability says otherwise. These tests pin the behaviours that used
 * to be `provider === 'codex'` conditionals scattered through the UI, so a
 * further provider can be added by registering a descriptor rather than by
 * editing components.
 *
 * OpenCode earns its place here rather than getting its own file: a parity
 * suite that only ever sees two providers cannot catch a two-way branch that
 * happens to be right for both, which is exactly how `provider === 'codex'`
 * survived. Several assertions below are written over EVERY registered
 * native-model provider for that reason.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { AgentCapabilities, AgentProviderId, WorktreeInfo } from '../../../shared/ipc-types'
import { sessionsStore } from '../sessions.svelte'
import { setProjectRoot, refreshWorktreesFor } from '../worktrees.svelte'
import { initAgentCapabilities, capabilitiesFor, providerLabel } from '../agent-capabilities.svelte'

const PRIMARY = '/repo/primary.git'
const PROJECT_ROOT = '/repo'
const MAIN_WT = '/repo/primary/main'

const base: AgentCapabilities = {
  status: 'precise', resume: true, fork: true, tracking: 'full', mcp: true,
  modelOverride: 'native', shiftEnter: 'native', droppedPath: 'at-reference',
  gracefulShutdown: true, displayName: 'Codex', oscTitle: 'directory',
  reportingSetup: 'user-granted', modelSelector: 'model-id', reasoningEffort: true,
  nativeModelBrand: 'openai', modelCatalog: true, reportsSessionTitle: false,
}
const CAPS: Record<string, AgentCapabilities> = {
  claude: {
    ...base, displayName: 'Claude', status: 'osc', modelOverride: 'env',
    shiftEnter: 'escape-newline', droppedPath: 'newline-list',
    oscTitle: 'session-label', reportingSetup: 'automatic',
    modelSelector: 'model-ref', reasoningEffort: false,
    nativeModelBrand: undefined, modelCatalog: true,
  },
  codex: base,
  opencode: {
    ...base, displayName: 'OpenCode', oscTitle: 'constant',
    // The two honest differences from Codex: OpenCode needs no one-time trust
    // grant, and its OSC title is a fixed brand string rather than the cwd.
    reportingSetup: 'automatic', nativeModelBrand: 'opencode', reportsSessionTitle: true,
  },
}

beforeEach(async () => {
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    invoke: vi.fn((channel: string, arg?: unknown) => {
      if (channel === 'worktree:list') return Promise.resolve<WorktreeInfo[]>(
        [{ path: MAIN_WT, branch: 'main', isMain: true, isCurrent: false }],
      )
      if (channel === 'agent:providers') return Promise.resolve(['claude', 'codex', 'opencode'] as AgentProviderId[])
      if (channel === 'agent:capabilities') return Promise.resolve(CAPS[arg as string])
      if (channel === 'models:claude') return Promise.resolve([])
      return Promise.resolve(undefined)
    }),
    on: vi.fn(() => () => {}),
  }
  setProjectRoot(PRIMARY)
  await refreshWorktreesFor(PRIMARY)
  sessionsStore.reset()
  await initAgentCapabilities()
})

describe('capability discovery', () => {
  it('caches every registered provider so the UI never names one directly', () => {
    expect(capabilitiesFor('claude')?.droppedPath).toBe('newline-list')
    expect(capabilitiesFor('codex')?.droppedPath).toBe('at-reference')
  })

  it('labels a provider from its descriptor, falling back to its id', () => {
    expect(providerLabel('claude')).toBe('Claude')
    expect(providerLabel('codex')).toBe('Codex')
    // Cased from the descriptor, not from the id — 'opencode' would otherwise
    // render as 'Opencode'.
    expect(providerLabel('opencode')).toBe('OpenCode')
    // An unregistered provider still reads sensibly rather than blank.
    expect(providerLabel('gemini' as AgentProviderId)).toBe('Gemini')
    expect(providerLabel(undefined)).toBe('Agent')
  })
})

describe('session naming parity', () => {
  it('numbers each provider independently instead of sharing one sequence', () => {
    const a = sessionsStore.createClaude(PROJECT_ROOT, MAIN_WT)
    const b = sessionsStore.createClaude(PROJECT_ROOT, MAIN_WT)
    const c = sessionsStore.createCodex(PROJECT_ROOT, MAIN_WT)
    const d = sessionsStore.createCodex(PROJECT_ROOT, MAIN_WT)

    expect(sessionsStore.get(a)?.label).toBe('Claude')
    expect(sessionsStore.get(b)?.label).toBe('Claude 2')
    expect(sessionsStore.get(c)?.label).toBe('Codex')
    expect(sessionsStore.get(d)?.label).toBe('Codex 2')
  })

  it('launches both providers at the project root, never in a worktree', () => {
    const claude = sessionsStore.createClaude(PROJECT_ROOT, MAIN_WT)
    const codex = sessionsStore.createCodex(PROJECT_ROOT, MAIN_WT)
    expect(sessionsStore.get(claude)?.launchDir).toBe(PROJECT_ROOT)
    expect(sessionsStore.get(codex)?.launchDir).toBe(PROJECT_ROOT)
  })

  /**
   * Codex names its model with a bare id; Claude carries a structured ModelRef.
   * They must not cross: `Session.model` is the ModelRef, and
   * `spawnSessionFromAgent` inherits it as the model for a peer the session
   * spawns — so leaking Codex's id there would set it as a Claude peer's brain.
   */
  it('keeps the Codex model id on the target, out of the ModelRef slot', () => {
    const id = sessionsStore.createCodex(PROJECT_ROOT, MAIN_WT, { model: 'gpt-5.6-sol' })
    const session = sessionsStore.get(id)
    expect(session?.target).toEqual({ provider: 'codex', model: 'gpt-5.6-sol' })
    expect(session?.model).toBeUndefined()
  })

  it('flags reporting setup from the capability, not the provider id', () => {
    const claude = sessionsStore.createClaude(PROJECT_ROOT, MAIN_WT)
    const codex = sessionsStore.createCodex(PROJECT_ROOT, MAIN_WT)
    expect(sessionsStore.get(claude)?.reportingSetupNeeded).toBeUndefined()
    expect(sessionsStore.get(codex)?.reportingSetupNeeded).toBe(true)
  })
})

describe('OSC titles', () => {
  it('lets a session-label provider rename the session', () => {
    const id = sessionsStore.createClaude(PROJECT_ROOT, MAIN_WT)
    sessionsStore.applyOscTitle(id, '✳ refactor the parser')
    expect(sessionsStore.get(id)?.label).toBe('refactor the parser')
  })

  it('refuses a directory-title provider — it would rename to the cwd each turn', () => {
    const id = sessionsStore.createCodex(PROJECT_ROOT, MAIN_WT)
    const before = sessionsStore.get(id)?.label
    sessionsStore.applyOscTitle(id, '⠇ simpleedit')
    expect(sessionsStore.get(id)?.label).toBe(before)
  })

  it('still lets a plain terminal take its shell-set title', () => {
    const id = sessionsStore.createTerminal(MAIN_WT)
    sessionsStore.applyOscTitle(id, 'main: pnpm test')
    expect(sessionsStore.get(id)?.label).toBe('main: pnpm test')
  })
})

/**
 * Labelling is a cross-provider contract, and it had no coverage at all — which
 * is why splitting `customLabel` silently changed Claude and Codex too.
 */
describe('label stickiness parity', () => {
  const NATIVE: AgentProviderId[] = ['codex', 'opencode']

  it('lets an agent-reported title replace a model-id stand-in, for every provider', () => {
    for (const provider of NATIVE) {
      const id = sessionsStore.createNativeAgent(provider, PROJECT_ROOT, MAIN_WT, { model: 'some/model-id' })
      expect(sessionsStore.get(id)?.label).toBe('some/model-id')
      sessionsStore.applySessionTitle(id, 'Refactor the parser')
      expect(sessionsStore.get(id)?.label).toBe('Refactor the parser')
    }
  })

  it('does the same for a model-ref provider', () => {
    const id = sessionsStore.createClaude(PROJECT_ROOT, MAIN_WT, {
      model: { provider: 'anthropic', model: 'claude-sonnet-4-5' },
    })
    expect(sessionsStore.get(id)?.label).toBe('claude-sonnet-4-5')
    sessionsStore.applySessionTitle(id, 'Fix the flaky test')
    expect(sessionsStore.get(id)?.label).toBe('Fix the flaky test')
  })

  it('never overwrites a name the user chose', () => {
    for (const provider of NATIVE) {
      const id = sessionsStore.createNativeAgent(provider, PROJECT_ROOT, MAIN_WT, { label: 'My session' })
      sessionsStore.applySessionTitle(id, 'Something The Agent Picked')
      expect(sessionsStore.get(id)?.label).toBe('My session')
    }
  })

  it('never overwrites a rename, even over a model-id stand-in', () => {
    const id = sessionsStore.createNativeAgent('opencode', PROJECT_ROOT, MAIN_WT, { model: 'some/model-id' })
    sessionsStore.rename(id, 'Mine')
    sessionsStore.applySessionTitle(id, 'Agent Title')
    expect(sessionsStore.get(id)?.label).toBe('Mine')
  })
})
