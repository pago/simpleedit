import { render, screen, fireEvent, waitFor } from '@testing-library/svelte'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../../stores/worktrees.svelte', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../stores/worktrees.svelte')>()),
  projectRoot: () => '/repo',
  mainWorktree: () => ({ path: '/repo/main', branch: 'main', head: 'abc', isMain: true }),
}))
vi.mock('../../../stores/sessions.svelte', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../stores/sessions.svelte')>()
  return { ...actual, createSessionFromDefaults: vi.fn(() => 'agent-default-1') }
})

import PrDetail from '../PrDetail.svelte'
import { sessionsStore, createSessionFromDefaults } from '../../../stores/sessions.svelte'
import { _resetAllowlistedModelsForTests } from '../../../lib/agentModels'
import type { PrContext } from '../../../../shared/screenprs'

const CONTEXT: PrContext = {
  owner: 'ivx', repo: 'ui-pack', number: 2532, url: 'https://github.com/ivx/ui-pack/pull/2532',
  title: 'Virtualize the Table', author: 'dana', updatedAt: '2026-08-01T00:00:00Z',
  headSha: 'own-2', additions: 1, deletions: 0, changedFiles: 1,
  baseRefName: 'main', headRefName: 'table-virtualization', ci: 'green', ciFailing: [],
  reviewers: [], approvedByOther: false, body: '', diff: '',
}

let allowlist: string[]
let ollamaDown: boolean
let invoke: ReturnType<typeof vi.fn>
let createAgent: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  _resetAllowlistedModelsForTests()
  allowlist = ['sonnet', 'opencode/big-pickle', 'qwen3:8b']
  ollamaDown = false
  invoke = vi.fn(async (channel: string) => {
    if (channel === 'screenprs:drafts-load') return { drafts: {}, rev: 1 }
    if (channel === 'models:config-get') return { defaults: {}, submenuAllowlist: allowlist }
    if (channel === 'models:claude') {
      return [
        { provider: 'anthropic', model: 'opus', displayName: 'Opus' },
        { provider: 'anthropic', model: 'sonnet', displayName: 'Sonnet' },
      ]
    }
    if (channel === 'models:codex') return [{ model: 'gpt-5.5', displayName: 'GPT-5.5' }]
    if (channel === 'models:opencode') return [{ model: 'opencode/big-pickle', displayName: 'Big Pickle' }]
    if (channel === 'models:installed') {
      if (ollamaDown) throw new Error('connect ECONNREFUSED 127.0.0.1:11434')
      return [{ name: 'qwen3:8b', toolCapable: true }]
    }
    return []
  })
  vi.stubGlobal('api', { invoke, on: () => () => {} })
  createAgent = vi.spyOn(sessionsStore, 'createAgent').mockReturnValue('agent-1')
  vi.spyOn(sessionsStore, 'requestTerminalFocus').mockImplementation(() => {})
  vi.mocked(createSessionFromDefaults).mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function openMenu(): Promise<string[]> {
  await fireEvent.click(screen.getByRole('button', { name: 'Choose model' }))
  return screen.getAllByTestId('split-model').map((el) => el.textContent!.replace('✓', '').trim())
}

describe('desktop PR detail — Discuss with Agent model menu', () => {
  it('offers Default plus the Settings → Models allowlist, OpenCode and local included', async () => {
    render(PrDetail, { props: { context: CONTEXT } })
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('models:opencode'))
    await waitFor(async () =>
      expect(await openMenu()).toEqual(['Default', 'Claude · Sonnet', 'OpenCode · Big Pickle', 'Claude · qwen3:8b']),
    )
  })

  it('points to Settings → Models when the allowlist is empty, and only then', async () => {
    allowlist = []
    render(PrDetail, { props: { context: CONTEXT } })
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('models:config-get'))
    await waitFor(async () => {
      expect(await openMenu()).toEqual(['Default'])
      expect(screen.getByTestId('models-hint')).toHaveTextContent('Pick models for this list in Settings → Models.')
    })

    allowlist = ['sonnet']
    _resetAllowlistedModelsForTests()
    await fireEvent.click(screen.getByRole('button', { name: 'Choose model' }))
    await waitFor(() => expect(screen.queryByTestId('models-hint')).toBeNull())
  })

  it('still lists the cloud models while Ollama is down', async () => {
    ollamaDown = true
    render(PrDetail, { props: { context: CONTEXT } })
    await waitFor(async () => expect(await openMenu()).toEqual(['Default', 'Claude · Sonnet', 'OpenCode · Big Pickle']))
  })

  it('starts an OpenCode pick on its target, named for the PR', async () => {
    render(PrDetail, { props: { context: CONTEXT } })
    await waitFor(async () => expect(await openMenu()).toContain('OpenCode · Big Pickle'))
    await fireEvent.click(screen.getAllByTestId('split-model').find((el) => el.textContent?.includes('Big Pickle'))!)
    expect(createAgent).toHaveBeenCalledWith(
      { provider: 'opencode', model: 'opencode/big-pickle' },
      '/repo',
      '/repo/main',
      expect.objectContaining({ label: 'review ui-pack#2532' }),
    )
    expect(screen.getByTitle(/Start with OpenCode · Big Pickle/)).toBeInTheDocument()
  })

  it('starts Default the way a plain new session starts', async () => {
    render(PrDetail, { props: { context: CONTEXT } })
    await fireEvent.click(screen.getByTitle(/Start with Default/))
    await waitFor(() => expect(createSessionFromDefaults).toHaveBeenCalledTimes(1))
    expect(vi.mocked(createSessionFromDefaults).mock.calls[0]).toEqual([
      { defaults: {}, submenuAllowlist: allowlist },
      '/repo',
      '/repo/main',
      expect.objectContaining({ label: 'review ui-pack#2532', initialPrompt: expect.stringContaining('REVIEW session') }),
    ])
    expect(createAgent).not.toHaveBeenCalled()
  })

  it('keeps a pick the allowlist dropped, and rereads the allowlist when the menu opens', async () => {
    render(PrDetail, { props: { context: CONTEXT } })
    await waitFor(async () => expect(await openMenu()).toContain('Claude · Sonnet'))
    await fireEvent.click(screen.getAllByTestId('split-model').find((el) => el.textContent?.includes('Sonnet'))!)

    allowlist = ['opencode/big-pickle']
    _resetAllowlistedModelsForTests()
    await fireEvent.click(screen.getByRole('button', { name: 'Choose model' }))
    const entries = (): string[] => screen.getAllByTestId('split-model').map((el) => el.textContent!.trim())
    await waitFor(() => expect(entries()).toEqual(['Default', 'Claude · sonnet ✓', 'OpenCode · Big Pickle']))
    expect(screen.getByTitle(/Start with Claude · sonnet/)).toBeInTheDocument()
  })
})
