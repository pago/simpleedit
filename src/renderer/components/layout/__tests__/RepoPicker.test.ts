import { render, screen, fireEvent } from '@testing-library/svelte'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import RepoPicker from '../RepoPicker.svelte'
import { sessionsStore } from '../../../stores/sessions.svelte'

beforeEach(() => {
  vi.stubGlobal('api', {
    invoke: vi.fn((channel: string) => {
      if (channel === 'memory:resolve') {
        return Promise.resolve({ memoryDir: '/home/u/.claude/projects/-proj/memory', exists: false, git: null })
      }
      return Promise.resolve(undefined)
    }),
    on: vi.fn(() => () => {}),
  })
  sessionsStore.reset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function openMenu(): Promise<void> {
  await fireEvent.click(screen.getByRole('button', { name: /▾/ }))
}

describe('RepoPicker Claude memory entry', () => {
  it('is offered for a Claude session', async () => {
    const id = sessionsStore.createAgent({ provider: 'claude' }, '/proj', '/proj/main')
    sessionsStore.select(id)
    render(RepoPicker, { onpickother: () => {} })
    await openMenu()
    expect(screen.getByRole('menuitem', { name: 'Claude memory' })).toBeInTheDocument()
  })

  it('is not offered for a plain terminal', async () => {
    const id = sessionsStore.createTerminal('/proj/main')
    sessionsStore.select(id)
    render(RepoPicker, { onpickother: () => {} })
    await openMenu()
    expect(screen.queryByRole('menuitem', { name: 'Claude memory' })).not.toBeInTheDocument()
  })

  it('is not offered for a Codex session', async () => {
    const id = sessionsStore.createAgent({ provider: 'codex' }, '/proj', '/proj/main')
    sessionsStore.select(id)
    render(RepoPicker, { onpickother: () => {} })
    await openMenu()
    expect(screen.queryByRole('menuitem', { name: 'Claude memory' })).not.toBeInTheDocument()
  })

  it('opens the memory view and relabels the picker', async () => {
    const id = sessionsStore.createAgent({ provider: 'claude' }, '/proj', '/proj/main')
    sessionsStore.select(id)
    render(RepoPicker, { onpickother: () => {} })
    await openMenu()
    await fireEvent.click(screen.getByRole('menuitem', { name: 'Claude memory' }))
    await vi.waitFor(() => expect(sessionsStore.get(id)?.memoryView).toBeDefined())
    expect(await screen.findByRole('button', { name: /Claude memory ▾/ })).toBeInTheDocument()
  })
})
