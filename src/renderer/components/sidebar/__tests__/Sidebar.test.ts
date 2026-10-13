import { render, screen, fireEvent, waitFor } from '@testing-library/svelte'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SessionsAttention } from '../../../lib/sessionsAttention'

let attentionNow: SessionsAttention
vi.mock('../../../stores/sessionAttention.svelte', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../stores/sessionAttention.svelte')>()),
  currentSessionsAttention: () => attentionNow,
}))

import Sidebar from '../Sidebar.svelte'
import { uiView } from '../../../stores/uiView.svelte'
import { backlogStore, _resetBacklogForTests } from '../../../stores/backlog.svelte'
import { screenPrsStore } from '../../../stores/screenprs.svelte'
import { sessionsStore } from '../../../stores/sessions.svelte'
import { refreshWorktrees } from '../../../stores/worktrees.svelte'
import { backlogView, _resetBacklogViewForTests } from '../../../stores/backlogViewState.svelte'
import type { ScreenPrCard } from '../../../../shared/screenprs'

const NONE: SessionsAttention = { level: 'none', counts: { error: 0, waiting: 0, unseen: 0, running: 0 } }

function header(name: string): HTMLElement {
  return screen.getByRole('button', { name: new RegExp(`^${name}`) })
}

function attentionCard(number: number): ScreenPrCard {
  return {
    owner: 'acme', repo: 'acme/widgets', url: `https://github.com/acme/widgets/pull/${number}`,
    title: `PR ${number}`, author: 'dana', updatedAt: '2026-08-01T00:00:00Z',
    headSha: `sha${number}`, additions: 1, deletions: 0, changedFiles: 1,
    baseRefName: 'main', headRefName: `feat-${number}`, ci: 'green', ciFailing: [],
    reviewers: [], approvedByOther: false, body: '', diff: '',
    impact: 'high', findings: [], bucket: 'attention', number,
  }
}

beforeEach(async () => {
  attentionNow = NONE
  _resetBacklogForTests()
  _resetBacklogViewForTests()
  vi.stubGlobal('api', {
    invoke: vi.fn(async (channel: string) => {
      if (channel === 'worktree:list') return [{ path: '/repo/main', branch: 'main', isMain: true, isCurrent: true }]
      if (channel === 'backlog:load') {
        return { project: '/repo/p.git', items: ['b_aaaaaaaa', 'b_bbbbbbbb'].map((id) => ({ id, prompt: 'p', version: 1, createdAt: 'a', updatedAt: 'a', createdBy: 'desktop' })), rev: 1 }
      }
      if (channel === 'screenprs:filter-get') return { filter: { owner: '', cutoffDays: 30 }, rev: 1 }
      if (channel === 'models:config-get') return { defaults: {} }
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
  uiView.show('workspace')
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Sidebar', () => {
  it('opens the section of the current view, and only that one', async () => {
    render(Sidebar)
    expect(header('Sessions')).toHaveAttribute('aria-expanded', 'true')
    expect(header('Backlog')).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByText('No sessions — start an agent or terminal')).toBeInTheDocument()

    uiView.show('screenprs')
    await waitFor(() => expect(header('Screen PRs')).toHaveAttribute('aria-expanded', 'true'))
    expect(header('Sessions')).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('No sessions — start an agent or terminal')).toBeNull()
    expect(screen.getByTestId('screenprs-queue')).toBeInTheDocument()
  })

  it('switches the view from a header, and the open header does nothing', async () => {
    render(Sidebar)
    await fireEvent.click(header('Backlog'))
    expect(uiView.current()).toBe('backlog')
    expect(await screen.findByTestId('backlog-list')).toBeInTheDocument()

    await fireEvent.click(header('Backlog'))
    expect(uiView.current()).toBe('backlog')

    await fireEvent.click(header('Sessions'))
    expect(uiView.current()).toBe('workspace')
    await waitFor(() => expect(screen.queryByTestId('backlog-list')).toBeNull())
  })

  it('shows the backlog count and the Screen PRs attention count', async () => {
    screenPrsStore._onCard(attentionCard(7))
    render(Sidebar)
    expect(header('Backlog')).toHaveTextContent('Backlog 2')
    expect(header('Screen PRs')).toHaveTextContent('Screen PRs 1')
  })

  it("shows the most urgent session state on the Sessions header, with counts as its tooltip", () => {
    attentionNow = { level: 'waiting', counts: { error: 0, waiting: 2, unseen: 1, running: 0 } }
    uiView.show('backlog')
    render(Sidebar)
    const dot = screen.getByTestId('sessions-attention')
    expect(dot.querySelector('[data-level]')).toHaveAttribute('data-level', 'waiting')
    expect(dot).toHaveAttribute('title', '2 awaiting input · 1 finished')
  })

  it('keeps the session buttons usable while Sessions is collapsed, without toggling it by accident', async () => {
    const createTerminal = vi.spyOn(sessionsStore, 'createTerminal').mockImplementation(() => 'term-1')
    uiView.show('backlog')
    render(Sidebar)

    // The provider menu opens over the backlog; nothing bubbles to the header.
    await fireEvent.contextMenu(screen.getByRole('button', { name: 'New agent session' }))
    expect(uiView.current()).toBe('backlog')
    expect(await screen.findByText('New terminal')).toBeInTheDocument()
    await fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })

    // Starting a session is the user's, so it brings the workspace forward.
    await fireEvent.click(screen.getByTitle('New terminal'))
    expect(createTerminal).toHaveBeenCalledWith('/repo/main')
    expect(uiView.current()).toBe('workspace')
  })

  it('adds a backlog item from the Backlog header while Backlog is collapsed', async () => {
    render(Sidebar)
    expect(header('Backlog')).toHaveAttribute('aria-expanded', 'false')

    await fireEvent.click(screen.getByRole('button', { name: '+ New' }))
    expect(uiView.current()).toBe('backlog')
    await waitFor(() => expect(backlogStore.selectedId).toMatch(/^b_/))
    expect(backlogStore.selectedId).toBe(backlogView.newId)
    expect(await screen.findByText('New item')).toBeInTheDocument()
  })

  it('screens from the Screen PRs header while Screen PRs is collapsed, and stops from there too', async () => {
    const invoke = window.api.invoke as ReturnType<typeof vi.fn>
    render(Sidebar)
    expect(header('Screen PRs')).toHaveAttribute('aria-expanded', 'false')

    await fireEvent.click(screen.getByRole('button', { name: 'Screen' }))
    expect(uiView.current()).toBe('screenprs')
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('screenprs:start', expect.anything()))

    uiView.show('workspace')
    await fireEvent.click(await screen.findByRole('button', { name: 'Stop' }))
    expect(invoke).toHaveBeenCalledWith('screenprs:cancel')
    expect(uiView.current()).toBe('workspace')
  })
})
