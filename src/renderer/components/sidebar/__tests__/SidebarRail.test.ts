import { render, screen, fireEvent, waitFor } from '@testing-library/svelte'
import { tick } from 'svelte'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import SidebarRail from '../SidebarRail.svelte'
import { uiView } from '../../../stores/uiView.svelte'
import { sidebarRail, HOVER_OPEN_MS, HOVER_CLOSE_MS, _resetSidebarRailForTests } from '../../../stores/sidebarRail.svelte'
import { backlogStore, _resetBacklogForTests } from '../../../stores/backlog.svelte'
import { screenPrsStore } from '../../../stores/screenprs.svelte'
import { sessionsStore } from '../../../stores/sessions.svelte'
import type { ScreenPrCard } from '../../../../shared/screenprs'
import { refreshWorktrees } from '../../../stores/worktrees.svelte'
import { _resetBacklogViewForTests } from '../../../stores/backlogViewState.svelte'

const WIDTHS = { workspace: 260, backlog: 340, screenprs: 380 }

function card(number: number): ScreenPrCard {
  return {
    owner: 'acme', repo: 'acme/widgets', url: `https://github.com/acme/widgets/pull/${number}`,
    title: `PR ${number}`, author: 'dana', updatedAt: '2026-08-01T00:00:00Z',
    headSha: `sha${number}`, additions: 1, deletions: 0, changedFiles: 1,
    baseRefName: 'main', headRefName: `feat-${number}`, ci: 'green', ciFailing: [],
    reviewers: [], approvedByOther: false, body: '', diff: '',
    impact: 'low', findings: [], bucket: 'quick', number,
  }
}

function icon(name: string): HTMLElement {
  return screen.getByRole('button', { name })
}

function zone(): HTMLElement {
  return screen.getByRole('navigation', { name: 'Sidebar sections' }).parentElement!
}

function overlay(): HTMLElement | null {
  return screen.queryByRole('dialog')
}

async function hover(name: string): Promise<void> {
  await fireEvent.pointerEnter(zone())
  await fireEvent.pointerEnter(icon(name))
}

async function advance(ms: number): Promise<void> {
  vi.advanceTimersByTime(ms)
  await tick()
}

beforeEach(async () => {
  _resetSidebarRailForTests(true)
  _resetBacklogForTests()
  _resetBacklogViewForTests()
  vi.stubGlobal('api', {
    invoke: vi.fn(async (channel: string) => {
      if (channel === 'worktree:list') return [{ path: '/repo/main', branch: 'main', isMain: true, isCurrent: true }]
      if (channel === 'backlog:load') {
        return {
          project: '/repo/p.git',
          items: [['b_aaaaaaaa', 'First'], ['b_bbbbbbbb', 'Second']].map(([id, prompt]) => ({ id, prompt, version: 1, createdAt: 'a', updatedAt: 'a', createdBy: 'desktop' })),
          rev: 1,
        }
      }
      if (channel === 'screenprs:filter-get') return { filter: { owner: '', cutoffDays: 30 }, rev: 1 }
      if (channel === 'models:config-get') return { defaults: {}, submenuAllowlist: [] }
      if (channel.startsWith('models:')) return []
      return undefined
    }),
    on: () => () => {},
    once: vi.fn(),
  })
  await refreshWorktrees()
  await backlogStore.load()
  screenPrsStore._onQueued([])
  screenPrsStore._onStatus('done', 0)
  uiView.show('workspace')
})

afterEach(() => {
  vi.useRealTimers()
  _resetSidebarRailForTests()
  uiView.show('workspace')
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('SidebarRail', () => {
  it('marks the current view and shows each section indicator', () => {
    uiView.show('backlog')
    render(SidebarRail, { widths: WIDTHS })
    expect(icon('Backlog')).toHaveAttribute('aria-current', 'true')
    expect(icon('Sessions')).not.toHaveAttribute('aria-current')
    expect(icon('Backlog')).toHaveTextContent('2')
    expect(screen.getByTestId('rail-sessions-attention').querySelector('[data-level]')).toBeInTheDocument()
  })

  it('previews a section after a short hover, and switches as the pointer moves between icons', async () => {
    vi.useFakeTimers()
    render(SidebarRail, { widths: WIDTHS })

    await hover('Backlog')
    await advance(HOVER_OPEN_MS - 10)
    expect(overlay()).toBeNull()
    await advance(10)
    expect(overlay()).toHaveAccessibleName('Backlog')
    expect(overlay()!.style.width).toBe('340px')
    expect(icon('Backlog')).toHaveAttribute('aria-expanded', 'true')
    expect(icon('Backlog')).toHaveAttribute('aria-controls', overlay()!.id)

    await fireEvent.pointerEnter(icon('Screen PRs'))
    expect(overlay()).toHaveAccessibleName('Screen PRs')
    expect(screen.getByTestId('screenprs-queue')).toBeInTheDocument()
    // Previewing never changes the view.
    expect(uiView.current()).toBe('workspace')
  })

  it('opens nothing when the pointer only passes over an icon', async () => {
    vi.useFakeTimers()
    render(SidebarRail, { widths: WIDTHS })
    await hover('Backlog')
    await fireEvent.pointerLeave(icon('Backlog'))
    await advance(HOVER_OPEN_MS * 2)
    expect(overlay()).toBeNull()
  })

  it('closes a preview shortly after the pointer leaves the rail and the overlay, unless it comes back', async () => {
    vi.useFakeTimers()
    render(SidebarRail, { widths: WIDTHS })
    await hover('Backlog')
    await advance(HOVER_OPEN_MS)

    await fireEvent.pointerLeave(zone())
    await advance(HOVER_CLOSE_MS - 50)
    await fireEvent.pointerEnter(zone())
    await advance(HOVER_CLOSE_MS)
    expect(overlay()).not.toBeNull()

    await fireEvent.pointerLeave(zone())
    await advance(HOVER_CLOSE_MS)
    expect(overlay()).toBeNull()
  })

  it('stays open after any interaction inside it, so a drag or a menu is not cut short', async () => {
    vi.useFakeTimers()
    render(SidebarRail, { widths: WIDTHS })
    await hover('Backlog')
    await advance(HOVER_OPEN_MS)
    await fireEvent.pointerDown(screen.getByTestId('backlog-list'))
    await fireEvent.pointerLeave(zone())
    await advance(HOVER_CLOSE_MS * 3)
    expect(overlay()).toHaveAccessibleName('Backlog')
  })

  it('pins on click, moving focus in; Esc closes and gives focus back', async () => {
    vi.useFakeTimers()
    render(SidebarRail, { widths: WIDTHS })
    icon('Screen PRs').focus()
    await fireEvent.click(icon('Screen PRs'))
    await tick()
    await tick()
    expect(overlay()).toHaveAccessibleName('Screen PRs')
    expect(overlay()).toHaveFocus()
    expect(uiView.current()).toBe('workspace')

    await fireEvent.pointerLeave(zone())
    await advance(HOVER_CLOSE_MS * 3)
    expect(overlay()).not.toBeNull()

    await fireEvent.keyDown(overlay()!, { key: 'Escape' })
    expect(overlay()).toBeNull()
    await tick()
    expect(icon('Screen PRs')).toHaveFocus()
  })

  it('closes a pinned overlay on a second click or a click outside', async () => {
    render(SidebarRail, { widths: WIDTHS })
    await fireEvent.click(icon('Backlog'))
    expect(overlay()).not.toBeNull()
    await fireEvent.click(icon('Backlog'))
    expect(overlay()).toBeNull()

    await fireEvent.click(icon('Backlog'))
    await fireEvent.pointerDown(document.body)
    expect(overlay()).toBeNull()
  })

  it('leaves Esc to a menu opened inside it', async () => {
    render(SidebarRail, { widths: WIDTHS })
    await fireEvent.click(icon('Sessions'))
    await fireEvent.contextMenu(screen.getByRole('button', { name: 'New agent session' }))
    const menu = await screen.findByRole('menu')
    await fireEvent.keyDown(menu, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(overlay()).not.toBeNull()
  })

  it('closes when an item is chosen, bringing its view forward', async () => {
    render(SidebarRail, { widths: WIDTHS })
    await fireEvent.click(icon('Backlog'))
    // The list shows its first item by itself; that is not a pick.
    await waitFor(() => expect(backlogStore.selectedId).toBe('b_aaaaaaaa'))
    expect(overlay()).not.toBeNull()

    await fireEvent.click(screen.getByRole('button', { name: /^Second/ }))
    await waitFor(() => expect(overlay()).toBeNull())
    expect(backlogStore.selectedId).toBe('b_bbbbbbbb')
    expect(uiView.current()).toBe('backlog')
  })

  it('closes on a click of the item already shown, bringing its view forward', async () => {
    render(SidebarRail, { widths: WIDTHS })
    await fireEvent.click(icon('Backlog'))
    await waitFor(() => expect(backlogStore.selectedId).toBe('b_aaaaaaaa'))
    await fireEvent.click(screen.getByRole('button', { name: /^First/ }))
    expect(overlay()).toBeNull()
    expect(uiView.current()).toBe('backlog')
    expect(backlogStore.selectedId).toBe('b_aaaaaaaa')
  })

  it('closes on a click of the PR already shown, bringing Screen PRs forward', async () => {
    screenPrsStore._onCard(card(7))
    screenPrsStore.select(card(7).url)
    render(SidebarRail, { widths: WIDTHS })
    await fireEvent.click(icon('Screen PRs'))
    await fireEvent.click(screen.getByText('PR 7').closest('button')!)
    expect(overlay()).toBeNull()
    expect(uiView.current()).toBe('screenprs')
    expect(screenPrsStore.selectedKey()).toBe(card(7).url)
  })

  it('closes when Start in the Backlog overlay opens the session', async () => {
    const invoke = window.api.invoke as ReturnType<typeof vi.fn>
    const answer = invoke.getMockImplementation() as (channel: string, ...args: unknown[]) => Promise<unknown>
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) =>
      channel === 'backlog:start' ? { terminalId: 'agent-1', label: 'x' } : answer(channel, ...args),
    )
    vi.spyOn(sessionsStore, 'select').mockImplementation(() => {})
    render(SidebarRail, { widths: WIDTHS })
    await fireEvent.click(icon('Backlog'))
    await waitFor(() => expect(backlogStore.selectedId).toBe('b_aaaaaaaa'))
    await fireEvent.click(screen.getAllByRole('button', { name: 'Start' })[0])
    await waitFor(() => expect(overlay()).toBeNull())
    expect(uiView.current()).toBe('workspace')
  })

  it("carries each section's header action in its overlay, which closes once used", async () => {
    const invoke = window.api.invoke as ReturnType<typeof vi.fn>
    render(SidebarRail, { widths: WIDTHS })
    await fireEvent.click(icon('Backlog'))
    await fireEvent.click(screen.getByRole('button', { name: '+ New' }))
    await waitFor(() => expect(overlay()).toBeNull())
    expect(uiView.current()).toBe('backlog')
    await waitFor(() => expect(backlogStore.selectedId).toMatch(/^b_/))
    expect(backlogStore.selectedId).not.toBe('b_aaaaaaaa')

    uiView.show('workspace')
    await fireEvent.click(icon('Screen PRs'))
    await fireEvent.click(screen.getByRole('button', { name: 'Screen' }))
    await waitFor(() => expect(overlay()).toBeNull())
    expect(uiView.current()).toBe('screenprs')
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('screenprs:start', expect.anything()))
  })

  it('closes any section when the active session changes', async () => {
    render(SidebarRail, { widths: WIDTHS })
    await fireEvent.click(icon('Screen PRs'))
    const id = sessionsStore.createTerminal('/repo/main')
    try {
      await waitFor(() => expect(overlay()).toBeNull())
    } finally {
      sessionsStore.close(id, { ptyAlreadyDead: true })
    }
  })

  it('gives focus back after a pick from an overlay opened by keyboard', async () => {
    render(SidebarRail, { widths: WIDTHS })
    icon('Backlog').focus()
    sidebarRail.showSection('backlog')
    await waitFor(() => expect(overlay()).toHaveFocus())
    const second = screen.getByRole('button', { name: /^Second/ })
    second.focus()
    await fireEvent.click(second)
    expect(overlay()).toBeNull()
    await waitFor(() => expect(icon('Backlog')).toHaveFocus())
  })

  it('closes when the view changes, but ⌘1–3 while collapsed opens that section pinned', async () => {
    render(SidebarRail, { widths: WIDTHS })
    await fireEvent.click(icon('Backlog'))
    uiView.show('screenprs')
    await waitFor(() => expect(overlay()).toBeNull())

    sidebarRail.showSection('backlog')
    await tick()
    expect(uiView.current()).toBe('backlog')
    expect(overlay()).toHaveAccessibleName('Backlog')
    await tick()
    expect(overlay()).not.toBeNull()
  })
})

describe('sidebarRail store', () => {
  it('only opens a section from ⌘1–3 while collapsed, and expanding closes the overlay', () => {
    sidebarRail.setCollapsed(false)
    sidebarRail.showSection('backlog')
    expect(uiView.current()).toBe('backlog')
    expect(sidebarRail.overlay()).toBeNull()

    sidebarRail.setCollapsed(true)
    sidebarRail.showSection('screenprs')
    expect(sidebarRail.overlay()).toMatchObject({ view: 'screenprs', pinned: true })
    sidebarRail.setCollapsed(false)
    expect(sidebarRail.overlay()).toBeNull()
  })
})
