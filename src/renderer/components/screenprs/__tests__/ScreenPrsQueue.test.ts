import { render, screen, fireEvent } from '@testing-library/svelte'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import ScreenPrsQueue from '../ScreenPrsQueue.svelte'
import ScreenPrsView from '../ScreenPrsView.svelte'
import { screenPrsStore } from '../../../stores/screenprs.svelte'
import type { ScreenPrCard } from '../../../../shared/screenprs'
import { _receiveReviewChange, _resetReviewRoomForTests } from '../../../stores/reviewRoom.svelte'

function card(over: Partial<ScreenPrCard> & Pick<ScreenPrCard, 'number' | 'bucket'>): ScreenPrCard {
  return {
    owner: 'acme', repo: 'acme/widgets', url: `https://github.com/acme/widgets/pull/${over.number}`,
    title: `PR ${over.number}`, author: 'dana', updatedAt: '2026-08-01T00:00:00Z',
    headSha: `sha${over.number}`, additions: 1, deletions: 0, changedFiles: 1,
    baseRefName: 'main', headRefName: `feat-${over.number}`, ci: 'green', ciFailing: [],
    reviewers: [], approvedByOther: false, body: '', diff: '',
    impact: 'low', findings: [],
    ...over,
  }
}

beforeEach(() => {
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'screenprs:filter-get') return { filter: { owner: '', cutoffDays: 30 }, rev: 1 }
    if (channel === 'models:config-get') return { defaults: {} }
    if (channel === 'models:claude') return []
    return undefined
  })
  vi.stubGlobal('api', { invoke, on: () => () => {} })
  screenPrsStore.select(null)
  screenPrsStore._onQueued([])
  screenPrsStore._onStatus('done', 0)
})

describe('ScreenPrsQueue', () => {
  it('says so when nothing awaits review, and why screening failed', async () => {
    render(ScreenPrsQueue)
    expect(screen.getByText('No open PRs awaiting your review.')).toBeTruthy()
    screenPrsStore._onStatus('error', 0, 'gh is not logged in')
    expect(await screen.findByText('Screening failed')).toBeTruthy()
    expect(screen.getByText('gh is not logged in')).toBeTruthy()
  })

  it('lists cards by bucket and selects the one clicked', async () => {
    screenPrsStore._onCard(card({ number: 1, bucket: 'quick' }))
    screenPrsStore._onCard(card({ number: 2, bucket: 'attention', impact: 'high' }))
    render(ScreenPrsQueue)
    expect(screen.getByText('Needs your attention')).toBeTruthy()
    expect(screen.getByText('Quick pass')).toBeTruthy()
    await fireEvent.click(screen.getByText('PR 1'))
    expect(screenPrsStore.selectedKey()).toBe('https://github.com/acme/widgets/pull/1')
  })

  it('asks before a quick approve posts anything', async () => {
    screenPrsStore._onCard(card({ number: 3, bucket: 'quick' }))
    render(ScreenPrsQueue)
    await fireEvent.click(screen.getByTitle('Quick approve — post an Approve review to GitHub'))
    expect(screen.getByRole('dialog', { name: 'Confirm review' })).toBeTruthy()
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('ScreenPrsView', () => {
  it('shows a hint until a PR is picked', () => {
    render(ScreenPrsView)
    expect(screen.queryByTestId('screenprs-queue')).toBeNull()
    expect(screen.getByText('Pick a PR from the queue to review it.')).toBeTruthy()
  })
})

describe('ScreenPrsQueue — Requested', () => {
  it('lists reviews an agent asked for, without opening them, and opens one on click', async () => {
    _resetReviewRoomForTests()
    const url = 'https://github.com/acme/widgets/pull/77'
    _receiveReviewChange({
      reviewId: 'r_request01',
      review: {
        id: 'r_request01', repo: 'github.com/acme/widgets', status: 'open', requesterSessionId: 'agent-claude-x',
        layers: [{ url, number: 77, headSha: 'h', title: 'Add the limit' }], companionAgent: { provider: 'claude', model: '' },
        lastSeenHead: {}, readSteps: [], round: 3, submissions: [], createdAt: '2026-10-16T00:00:00Z', updatedAt: '2026-10-16T00:00:00Z',
      },
      rev: 1,
    })
    render(ScreenPrsQueue)
    const group = screen.getByTestId('screenprs-requested')
    expect(group.textContent).toContain('Add the limit')
    expect(group.textContent).toContain('round 3')
    expect(screenPrsStore.selectedKey()).toBeNull()
    await fireEvent.click(screen.getByText('Add the limit'))
    expect(screenPrsStore.selectedKey()).toBe(url)
  })
})
