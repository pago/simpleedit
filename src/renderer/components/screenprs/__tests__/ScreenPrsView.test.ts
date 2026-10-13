import { render, screen, fireEvent } from '@testing-library/svelte'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import ScreenPrsView from '../ScreenPrsView.svelte'
import ScreenPrsButton from '../ScreenPrsButton.svelte'
import { screenPrsStore } from '../../../stores/screenprs.svelte'
import { _resetSidebarRailForTests } from '../../../stores/sidebarRail.svelte'

/** The org and cutoff are main's, saved for every window and phone, not this view's. */
let invoke: ReturnType<typeof vi.fn>
let saved: { owner: string; cutoffDays: number; autoScreenHours?: number }
// The store ignores snapshots older than one it has seen, and it is a module singleton.
let rev = 2_000

beforeEach(async () => {
  saved = { owner: 'acme', cutoffDays: 7, autoScreenHours: 0 }
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
    render(ScreenPrsButton)
    const field = screen.getByTestId('filter-owner')
    await fireEvent.focus(field)
    await fireEvent.input(field, { target: { value: 'widgets-inc' } })
    await fireEvent.blur(field)
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('screenprs:filter-set', { owner: 'widgets-inc', cutoffDays: 7, autoScreenHours: 0 }))

    await fireEvent.click(screen.getByRole('button', { name: /Screen/ }))
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('screenprs:start', expect.objectContaining({ owner: 'widgets-inc' })),
    )
  })

  it('saves the cutoff on change', async () => {
    render(ScreenPrsView)
    await fireEvent.change(screen.getByTestId('filter-cutoff'), { target: { value: '90' } })
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('screenprs:filter-set', { owner: 'acme', cutoffDays: 90, autoScreenHours: 0 }))
  })

  it('saves the auto-screen interval on change, and says when it screens next', async () => {
    render(ScreenPrsView)
    expect(screen.getByTestId('filter-auto')).toHaveValue('0')
    await fireEvent.change(screen.getByTestId('filter-auto'), { target: { value: '4' } })
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('screenprs:filter-set', { owner: 'acme', cutoffDays: 7, autoScreenHours: 4 }),
    )
    expect(screen.queryByTestId('schedule-hint')).toBeNull()
    // Half a minute off the boundaries: the view's clock was read at mount, a moment before these.
    screenPrsStore._onSchedule({ lastAt: Date.now() - 23.5 * 60_000, nextAt: Date.now() + 3 * 3_600_000 - 30_000 })
    expect(await screen.findByTestId('schedule-hint')).toHaveTextContent('screened 23m ago · next in 3h')
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
    render(ScreenPrsButton)
    await fireEvent.click(screen.getByRole('button', { name: /Screen/ }))
    await vi.waitFor(() => expect(screenPrsStore.status()).toBe('error'))
    expect(screenPrsStore.error()).toBe('gh is not signed in')
  })
})

describe('ScreenPrsView — collapsed sidebar', () => {
  it('carries Screen, then progress and Stop, in its own header only while the sidebar is collapsed to the rail', async () => {
    _resetSidebarRailForTests(false)
    render(ScreenPrsView)
    expect(screen.queryByRole('button', { name: 'Screen' })).toBeNull()

    _resetSidebarRailForTests(true)
    try {
      await fireEvent.click(await screen.findByRole('button', { name: 'Screen' }))
      await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('screenprs:start', expect.objectContaining({ owner: 'acme' })))
      screenPrsStore._onStatus('running', 10)
      expect(await screen.findByTestId('screening-progress')).toHaveTextContent('0/10')
      await fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
      expect(invoke).toHaveBeenCalledWith('screenprs:cancel')
    } finally {
      _resetSidebarRailForTests(false)
    }
  })
})
