import { render, screen, fireEvent, waitFor } from '@testing-library/svelte'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import BacklogSheet from '../BacklogSheet.svelte'
import BacklogScreen from '../BacklogScreen.svelte'
import { _resetBacklogForTests, backlogStore } from '../../renderer/stores/backlog.svelte'
import type { BacklogItem, BacklogSnapshot } from '../../shared/backlog'
import { _resetAllowlistedModelsForTests } from '../../renderer/lib/agentModels'

const P = '/repo/project.git'
let invoke: ReturnType<typeof vi.fn>
let closed: number

function item(id: string, over: Partial<BacklogItem> = {}): BacklogItem {
  return { id, prompt: `Do ${id}`, version: 1, createdAt: 'a', updatedAt: 'a', createdBy: 'desktop', ...over }
}

async function seed(items: BacklogItem[]): Promise<void> {
  invoke.mockImplementationOnce(async () => ({ project: P, items, rev: 1 }) satisfies BacklogSnapshot)
  await backlogStore.load()
}

beforeEach(() => {
  _resetBacklogForTests()
  _resetAllowlistedModelsForTests()
  closed = 0
  invoke = vi.fn(async (channel: string) => {
    if (channel === 'stt:status') return { ready: true, hint: '' }
    if (channel === 'models:claude') return []
    return undefined
  })
  vi.stubGlobal('api', { invoke, on: vi.fn(() => () => {}) })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('BacklogSheet', () => {
  it('adds an item with the text and closes', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'backlog:op') return { ok: true, snapshot: { project: P, items: [], rev: 2 } }
      return undefined
    })
    render(BacklogSheet, { props: { itemId: null, connected: true, onclose: () => closed++ } })
    await fireEvent.input(screen.getByTestId('composer-text'), { target: { value: 'Prepare the release notes' } })
    await fireEvent.click(screen.getByTestId('composer-send'))
    await waitFor(() => expect(closed).toBe(1))
    const [, ops] = invoke.mock.calls.find((c) => c[0] === 'backlog:op')!
    expect(ops).toEqual([{ kind: 'add', item: { id: expect.stringMatching(/^b_/), prompt: 'Prepare the release notes' } }])
  })

  it('keeps the text on a conflict and saves it again with Keep mine', async () => {
    await seed([item('b_aaaaaaaa')])
    const theirs = item('b_aaaaaaaa', { prompt: 'their edit', version: 2 })
    const updates: unknown[] = []
    invoke.mockImplementation(async (channel: string, ops: unknown) => {
      if (channel !== 'backlog:op') return undefined
      updates.push(ops)
      return updates.length === 1
        ? { ok: false, conflict: { id: 'b_aaaaaaaa', current: theirs }, snapshot: { project: P, items: [theirs], rev: 5 } }
        : { ok: true, snapshot: { project: P, items: [], rev: 6 } }
    })
    render(BacklogSheet, { props: { itemId: 'b_aaaaaaaa', connected: true, onclose: () => closed++ } })
    await fireEvent.input(screen.getByTestId('composer-text'), { target: { value: 'my edit' } })
    await fireEvent.click(screen.getByTestId('composer-send'))
    expect(await screen.findByTestId('backlog-conflict')).toBeTruthy()
    expect((screen.getByTestId('composer-text') as HTMLTextAreaElement).value).toBe('my edit')
    await fireEvent.click(screen.getByRole('button', { name: 'Keep mine' }))
    await fireEvent.click(screen.getByTestId('composer-send'))
    await waitFor(() => expect(closed).toBe(1))
    expect(updates[1]).toEqual([{ kind: 'update', id: 'b_aaaaaaaa', baseVersion: 2, patch: { prompt: 'my edit', target: null } }])
  })

  it('asks before Back throws away an unsaved edit', async () => {
    const { component } = render(BacklogSheet, { props: { itemId: null, connected: true, onclose: () => closed++ } })
    await fireEvent.input(screen.getByTestId('composer-text'), { target: { value: 'half a thought' } })
    expect(component.holdForDraft()).toBe(true)
    expect(await screen.findByTestId('backlog-discard')).toBeTruthy()
  })

  it('asks before Back throws away a changed model, even with the text untouched', async () => {
    await seed([item('b_aaaaaaaa')])
    const { component } = render(BacklogSheet, { props: { itemId: 'b_aaaaaaaa', connected: true, onclose: () => closed++ } })
    expect(component.atRisk()).toBe(false)
    const picked = JSON.stringify({ model: 'gpt-5.5', provider: 'codex' })
    const select = screen.getByTestId('backlog-model') as HTMLSelectElement
    select.add(new Option('Codex · GPT-5.5', picked))
    await fireEvent.change(select, { target: { value: picked } })
    expect(component.holdForDraft()).toBe(true)
    expect(await screen.findByTestId('backlog-discard')).toBeTruthy()
  })
})

describe('BacklogSheet model picker', () => {
  it('offers the Settings → Models allowlist, and names a model it lacks', async () => {
    await seed([item('b_aaaaaaaa', { target: { provider: 'codex', model: 'gpt-old' } })])
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'stt:status') return { ready: true, hint: '' }
      if (channel === 'models:config-get') return { defaults: {}, submenuAllowlist: ['anthropic/sonnet', 'claude-opus'] }
      if (channel === 'models:claude') return [{ model: 'claude-opus', displayName: 'Opus' }]
      if (channel === 'models:opencode') return [{ provider: 'opencode', model: 'anthropic/sonnet', displayName: 'Sonnet', supportedReasoningEfforts: [] }]
      if (channel === 'models:codex' || channel === 'models:installed') return []
      return undefined
    })
    render(BacklogSheet, { props: { itemId: 'b_aaaaaaaa', connected: true, onclose: () => {} } })
    const select = screen.getByTestId('backlog-model') as HTMLSelectElement
    await waitFor(() => expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['Default', 'Codex · gpt-old', 'OpenCode · Sonnet', 'Claude · Opus']))
    expect(select.selectedOptions[0].textContent).toBe('Codex · gpt-old')
  })
})

describe('BacklogScreen', () => {
  it('starts only after a second tap, and hands the session back', async () => {
    await seed([item('b_aaaaaaaa')])
    invoke.mockImplementation(async (channel: string) => (channel === 'backlog:start' ? { terminalId: 't1', label: 'x' } : undefined))
    const started: unknown[] = []
    render(BacklogScreen, { props: { connected: true, onopen: () => {}, onstarted: (c: unknown) => started.push(c) } })
    await fireEvent.click(screen.getByTestId('backlog-start'))
    expect(invoke).not.toHaveBeenCalledWith('backlog:start', expect.anything())
    await fireEvent.click(screen.getByTestId('backlog-start-confirm'))
    await waitFor(() => expect(started).toEqual([{ terminalId: 't1', label: 'x' }]))
  })

  it('disables Start for an item without a prompt, and says why', async () => {
    await seed([item('b_aaaaaaaa', { prompt: '', label: 'Look into flaky CI' })])
    render(BacklogScreen, { props: { connected: true, onopen: () => {}, onstarted: () => {} } })
    const start = screen.getByTestId('backlog-start') as HTMLButtonElement
    expect(start.disabled).toBe(true)
    expect(start.title).toBe('Write a prompt before starting this item.')
    expect(screen.getByText(/No prompt yet/)).toBeTruthy()
  })
})
