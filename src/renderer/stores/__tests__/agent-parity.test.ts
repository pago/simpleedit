/**
 * Provider parity: Claude and Codex must behave identically except where a
 * capability says otherwise. These tests pin the behaviours that used to be
 * `provider === 'codex'` conditionals scattered through the UI, so a third
 * provider (OpenCode, …) can be added by registering a descriptor rather than
 * by editing components.
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
  reportingSetup: 'user-granted',
}
const CAPS: Record<string, AgentCapabilities> = {
  claude: {
    ...base, displayName: 'Claude', status: 'osc', modelOverride: 'env',
    shiftEnter: 'escape-newline', droppedPath: 'newline-list',
    oscTitle: 'session-label', reportingSetup: 'automatic',
  },
  codex: base,
}

beforeEach(async () => {
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    invoke: vi.fn((channel: string, arg?: unknown) => {
      if (channel === 'worktree:list') return Promise.resolve<WorktreeInfo[]>(
        [{ path: MAIN_WT, branch: 'main', isMain: true, isCurrent: false }],
      )
      if (channel === 'agent:providers') return Promise.resolve(['claude', 'codex'] as AgentProviderId[])
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
    // An unregistered provider still reads sensibly rather than blank.
    expect(providerLabel('opencode' as AgentProviderId)).toBe('Opencode')
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
