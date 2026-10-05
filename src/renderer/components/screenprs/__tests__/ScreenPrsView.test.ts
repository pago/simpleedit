import { render, screen, fireEvent } from '@testing-library/svelte'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import ScreenPrsView from '../ScreenPrsView.svelte'
import { screenPrsStore } from '../../../stores/screenprs.svelte'

/** The org and cutoff are main's, saved for every window and phone, not this view's. */
let invoke: ReturnType<typeof vi.fn>
let saved: { owner: string; cutoffDays: number }
// The store ignores snapshots older than one it has seen, and it is a module singleton.
let rev = 2_000

beforeEach(async () => {
  saved = { owner: 'acme', cutoffDays: 7 }
  invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === 'screenprs:filter-get') return { filter: saved, rev: ++rev }
    if (channel === 'screenprs:filter-set') {
      const next = args[0] as { owner: string; cutoffDays: number }
      if (next.owner.startsWith('-')) throw new Error(`“${next.owner}” isn't a GitHub org or user name.`)
      saved = next
      return { filter: saved, rev: ++rev }
    }
    if (channel === 'models:config-get') return { defaults: {} }
    if (channel === 'models:claude') return []
    return undefined
  })
  vi.stubGlobal('api', { invoke, on: () => () => {} })
  screenPrsStore._onQueued([])
  screenPrsStore._onStatus('done', 0)
  await screenPrsStore.loadFilter()
})

describe('ScreenPrsView — the saved filter', () => {
  it('starts from the filter main holds, not a hard-coded 30 days', () => {
    render(ScreenPrsView)
    expect(screen.getByTestId('filter-owner')).toHaveValue('acme')
    expect(screen.getByTestId('filter-cutoff')).toHaveValue('7')
  })

  it('saves the org when the field is left, and screens with it', async () => {
    render(ScreenPrsView)
    const field = screen.getByTestId('filter-owner')
    await fireEvent.focus(field)
    await fireEvent.input(field, { target: { value: 'widgets-inc' } })
    await fireEvent.blur(field)
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('screenprs:filter-set', { owner: 'widgets-inc', cutoffDays: 7 }))

    await fireEvent.click(screen.getByRole('button', { name: /Screen/ }))
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('screenprs:start', expect.objectContaining({ owner: 'widgets-inc' })),
    )
  })

  it('saves the cutoff on change', async () => {
    render(ScreenPrsView)
    await fireEvent.change(screen.getByTestId('filter-cutoff'), { target: { value: '90' } })
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('screenprs:filter-set', { owner: 'acme', cutoffDays: 90 }))
  })

  it('puts back the saved org when main refuses one', async () => {
    render(ScreenPrsView)
    const field = screen.getByTestId('filter-owner')
    await fireEvent.focus(field)
    await fireEvent.input(field, { target: { value: '-bad' } })
    await fireEvent.blur(field)
    expect(await screen.findByTestId('filter-error')).toHaveTextContent("isn't a GitHub org")
    expect(field).toHaveValue('acme')
  })

  it('follows a change made on the phone, but not while the field is being typed in', async () => {
    render(ScreenPrsView)
    const field = screen.getByTestId('filter-owner')
    await fireEvent.focus(field)
    await fireEvent.input(field, { target: { value: 'typing' } })
    saved = { owner: 'phone-org', cutoffDays: 30 }
    await screenPrsStore.loadFilter()
    expect(field).toHaveValue('typing')
    expect(screen.getByTestId('filter-cutoff')).toHaveValue('30')

    // Leaving the field saves what was typed over the phone's change.
    await fireEvent.blur(field)
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('screenprs:filter-set', { owner: 'typing', cutoffDays: 30 }))
  })

  it('settles a screen main refuses instead of leaving it running', async () => {
    const base = invoke.getMockImplementation() as (channel: string, ...args: unknown[]) => Promise<unknown>
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'screenprs:start') throw new Error('gh is not signed in')
      return base(channel, ...args)
    })
    render(ScreenPrsView)
    await fireEvent.click(screen.getByRole('button', { name: /Screen/ }))
    await vi.waitFor(() => expect(screenPrsStore.status()).toBe('error'))
    expect(screenPrsStore.error()).toBe('gh is not signed in')
  })
})
