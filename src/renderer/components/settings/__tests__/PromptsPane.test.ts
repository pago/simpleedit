import { render, screen, fireEvent, waitFor, within } from '@testing-library/svelte'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { PromptInfo } from '../../../../shared/ipc-types'

// Monaco can't boot in the browser test runner; the pane's logic is what's under test.
vi.mock('../PromptEditor.svelte', async () => ({ default: (await import('./StubPromptEditor.svelte')).default }))
vi.mock('../../editor/MonacoDiffEditor.svelte', async () => ({ default: (await import('./StubDiffEditor.svelte')).default }))

const { default: PromptsPane } = await import('../PromptsPane.svelte')

const DIR = '/u/config/prompts'

function info(over: Partial<PromptInfo> & Pick<PromptInfo, 'id'>): PromptInfo {
  return {
    title: over.id,
    description: `About ${over.id}`,
    group: over.id === 'triage' ? 'screening' : 'deep-review',
    status: 'default',
    path: `${DIR}/${over.id}.md`,
    defaultVersion: 1,
    ...over,
  }
}

let list: PromptInfo[]
let invoke: ReturnType<typeof vi.fn>

beforeEach(() => {
  list = [
    info({ id: 'triage', title: 'Triage' }),
    info({ id: 'deep-review/soundness', title: 'Soundness & bugs', status: 'custom', basedOn: 1 }),
    info({ id: 'deep-review/tests', title: 'Test coverage', status: 'outdated', basedOn: 1, defaultVersion: 2 }),
    info({ id: 'deep-review/synthesis', title: 'Synthesis', status: 'error', error: 'The override is empty — using the default.' }),
  ]
  invoke = vi.fn((channel: string, id?: string) => {
    switch (channel) {
      case 'prompts:list':
        return Promise.resolve(list)
      case 'prompts:read':
        return Promise.resolve({ text: `custom ${id}`, defaultText: `default ${id}` })
      case 'prompts:customize':
        list = list.map((p) => (p.id === id ? { ...p, status: 'custom', basedOn: 1 } : p))
        return Promise.resolve(`${DIR}/${id}.md`)
      case 'prompts:mark-current':
        list = list.map((p) => (p.id === id ? { ...p, status: 'custom', basedOn: p.defaultVersion } : p))
        return Promise.resolve()
      case 'prompts:reset':
        list = list.map((p) => (p.id === id ? { ...p, status: 'default', basedOn: undefined } : p))
        return Promise.resolve()
      default:
        return Promise.resolve()
    }
  })
  vi.stubGlobal('api', { invoke, on: vi.fn(() => () => {}) })
})

afterEach(() => vi.unstubAllGlobals())

const row = (id: string): HTMLElement => screen.getByTestId(`prompt-row-${id}`)

describe('PromptsPane', () => {
  it('groups prompts and shows each status', async () => {
    render(PromptsPane)
    await screen.findByText('Triage')
    expect(within(screen.getByRole('region', { name: 'Screening' })).getByText('Triage')).toBeTruthy()
    expect(within(screen.getByRole('region', { name: 'Deep review' })).getByText('Synthesis')).toBeTruthy()
    expect(screen.getByTestId('prompt-status-triage').textContent?.trim()).toBe('Default')
    expect(screen.getByTestId('prompt-status-deep-review/soundness').textContent?.trim()).toBe('Custom')
    expect(screen.getByTestId('prompt-status-deep-review/tests').textContent?.trim()).toBe('Outdated')
    expect(screen.getByTestId('prompt-status-deep-review/synthesis').textContent?.trim()).toBe('Error')
    expect(within(row('deep-review/synthesis')).getByText(/override is empty/)).toBeTruthy()
  })

  it('offers only Customize for a default prompt, and management actions for an override', async () => {
    render(PromptsPane)
    await screen.findByText('Triage')
    expect(within(row('triage')).queryByRole('button', { name: /Reset/ })).toBeNull()
    expect(within(row('triage')).getByRole('button', { name: 'Customize Triage' })).toBeTruthy()
    const custom = within(row('deep-review/soundness'))
    for (const name of [/^Edit/, /^Compare/, /^Reveal/, /^Reset/]) expect(custom.getByRole('button', { name })).toBeTruthy()
  })

  it('Customize seeds the override and opens it in the editor', async () => {
    render(PromptsPane)
    await fireEvent.click(await screen.findByRole('button', { name: 'Customize Triage' }))
    expect(invoke).toHaveBeenCalledWith('prompts:customize', 'triage')
    const editor = (await screen.findByLabelText('Instructions for Triage')) as HTMLTextAreaElement
    expect(editor.value).toBe('custom triage')
    expect(screen.getByTestId('prompt-status-triage').textContent?.trim()).toBe('Custom')
  })

  it('Save is enabled only after an edit, and writes the edited text', async () => {
    render(PromptsPane)
    await fireEvent.click(await screen.findByRole('button', { name: 'Edit Soundness & bugs' }))
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    await fireEvent.input(screen.getByLabelText('Instructions for Soundness & bugs'), { target: { value: 'races only' } })
    expect(save.disabled).toBe(false)
    await fireEvent.click(save)
    expect(invoke).toHaveBeenCalledWith('prompts:save', 'deep-review/soundness', 'races only')
    await waitFor(() => expect(save.disabled).toBe(true))
  })

  it('Compare shows the default against the current text', async () => {
    render(PromptsPane)
    await fireEvent.click(await screen.findByRole('button', { name: 'Compare Test coverage with default' }))
    expect((await screen.findByTestId('diff-original')).textContent).toBe('default deep-review/tests')
    expect(screen.getByTestId('diff-modified').textContent).toBe('custom deep-review/tests')
    expect(screen.getByText(/now ships v2/)).toBeTruthy()
  })

  it('Reset asks for confirmation before deleting the override', async () => {
    render(PromptsPane)
    await fireEvent.click(await screen.findByRole('button', { name: 'Reset Soundness & bugs' }))
    expect(invoke).not.toHaveBeenCalledWith('prompts:reset', expect.anything())
    await fireEvent.click(within(row('deep-review/soundness')).getByRole('button', { name: 'Keep' }))
    expect(within(row('deep-review/soundness')).queryByRole('button', { name: 'Keep' })).toBeNull()
    await fireEvent.click(screen.getByRole('button', { name: 'Reset Soundness & bugs' }))
    await fireEvent.click(within(row('deep-review/soundness')).getByRole('button', { name: 'Reset' }))
    expect(invoke).toHaveBeenCalledWith('prompts:reset', 'deep-review/soundness')
    await waitFor(() => expect(screen.getByTestId('prompt-status-deep-review/soundness').textContent?.trim()).toBe('Default'))
  })

  it('offers Mark as up to date only on outdated prompts, and clears the flag', async () => {
    render(PromptsPane)
    await screen.findByText('Triage')
    expect(within(row('deep-review/soundness')).queryByRole('button', { name: /up to date/ })).toBeNull()
    await fireEvent.click(within(row('deep-review/tests')).getByRole('button', { name: 'Mark Test coverage as up to date' }))
    expect(invoke).toHaveBeenCalledWith('prompts:mark-current', 'deep-review/tests')
    await waitFor(() => expect(screen.getByTestId('prompt-status-deep-review/tests').textContent?.trim()).toBe('Custom'))
    expect(within(row('deep-review/tests')).queryByRole('button', { name: /up to date/ })).toBeNull()
  })

  it('offers Mark as up to date in the editor of an outdated prompt', async () => {
    render(PromptsPane)
    await fireEvent.click(await screen.findByRole('button', { name: 'Edit Test coverage' }))
    await fireEvent.click(await screen.findByRole('button', { name: 'Mark Test coverage as up to date' }))
    expect(invoke).toHaveBeenCalledWith('prompts:mark-current', 'deep-review/tests')
    await waitFor(() => expect(screen.queryByText(/now ships v2/)).toBeNull())
  })

  it('Reveal in Finder asks main to show the file', async () => {
    render(PromptsPane)
    await fireEvent.click(await screen.findByRole('button', { name: 'Reveal Soundness & bugs in Finder' }))
    expect(invoke).toHaveBeenCalledWith('prompts:reveal', 'deep-review/soundness')
  })

  it('surfaces a failed action instead of failing silently', async () => {
    render(PromptsPane)
    await screen.findByText('Triage')
    invoke.mockImplementationOnce(() => Promise.reject(new Error('EACCES: permission denied')))
    await fireEvent.click(screen.getByRole('button', { name: 'Customize Triage' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/EACCES/)
  })
})
