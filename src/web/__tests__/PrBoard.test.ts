import { render, screen, fireEvent } from '@testing-library/svelte'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import PrBoard from '../PrBoard.svelte'
import { screenPrsStore } from '../../renderer/stores/screenprs.svelte'
import type { PrRef, ScreenPrCard } from '../../shared/screenprs'

/**
 * Buckets ORDER the board; they do not gate it.
 *
 * An earlier draft of the plan let you approve only from `quick` and sent the
 * rest to the desk. That was wrong — GitHub's own app does full review, and the
 * anchoring problem it was meant to dodge is already solved in
 * `buildReviewPayload`. So the assertion here is that every card, in every
 * bucket, opens the same way.
 */
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

const CARDS = [
  card({ number: 1, bucket: 'fyi', approvedByOther: true }),
  card({ number: 2, bucket: 'waiting', ci: 'failing' }),
  card({ number: 3, bucket: 'quick' }),
  card({ number: 4, bucket: 'attention', impact: 'high', findings: [{ label: 'issue', file: 'a.ts', title: 'x' }] }),
]

beforeEach(() => {
  vi.stubGlobal('api', { invoke: vi.fn(async () => undefined), on: () => () => {} })
  screenPrsStore._onQueued([])
  for (const c of CARDS) screenPrsStore._onCard(c)
  screenPrsStore._onStatus('done', CARDS.length)
})

describe('PrBoard', () => {
  it('orders the sections attention → quick → waiting → fyi', () => {
    render(PrBoard, { onopen: vi.fn() })
    expect(screen.getAllByTestId('bucket').map((el) => el.dataset.bucket)).toEqual([
      'attention', 'quick', 'waiting', 'fyi',
    ])
  })

  it('opens a PR from every bucket, not just the quick one', async () => {
    const opened: PrRef[] = []
    render(PrBoard, { onopen: (pr: PrRef) => opened.push(pr) })

    for (const el of screen.getAllByTestId('pr-card')) await fireEvent.click(el)

    expect(opened.map((p) => p.number).sort()).toEqual([1, 2, 3, 4])
  })

  it('flags what makes an attention PR worth reading first', () => {
    render(PrBoard, { onopen: vi.fn() })
    const attention = screen.getAllByTestId('bucket')[0]
    expect(attention).toHaveTextContent('high impact')
    expect(attention.querySelector('[data-testid="issue-count"]')).toHaveTextContent('1 issue')
  })
})
