import { render, screen, fireEvent, within } from '@testing-library/svelte'
import { describe, it, expect, beforeEach } from 'vitest'
import SubmitReviewsModal from '../SubmitReviewsModal.svelte'
import { screenPrsStore } from '../../../stores/screenprs.svelte'
import type { ReviewSubmitRequest, ReviewSubmitResult } from '../../../../shared/review-room-ipc'
import { REVIEW_ID, layer, stubApi } from './fixtures'

const U1 = 'https://github.com/acme/app/pull/301'
const U2 = 'https://github.com/acme/app/pull/302'
const U3 = 'https://github.com/acme/app/pull/303'
const LAYERS = [layer(301, U1), layer(302, U2), layer(303, U3)]

let api: ReturnType<typeof stubApi>
let answer: (req: ReviewSubmitRequest) => ReviewSubmitResult

beforeEach(async () => {
  answer = (req) => ({ layers: req.layers.map((l) => ({ prUrl: l.prUrl, kind: 'posted', folded: 0 })), complete: true })
  api = stubApi((channel, ...args) => (channel === 'review:submit' ? answer(args[0] as ReviewSubmitRequest) : undefined))
  await screenPrsStore.loadDrafts()
  screenPrsStore.addComment(U1, { source: 'you', file: '', text: 'Must fix', severity: 'blocking', threadId: 'rt_blocking1' })
  screenPrsStore.addComment(U2, { source: 'you', file: 'src/a.ts', line: '3', text: 'Consider', severity: 'consider', sha: 'sha302', threadId: 'rt_consider1' })
})

function verdictOf(n: number): string | undefined {
  const group = screen.getByRole('radiogroup', { name: `Verdict for #${n}` })
  return within(group).getAllByRole<HTMLInputElement>('radio').find((r) => r.checked)?.value
}

describe('SubmitReviewsModal', () => {
  it('is a modal', () => {
    render(SubmitReviewsModal, { props: { reviewId: REVIEW_ID, layers: LAYERS, onclose: () => {} } })
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true')
  })

  it('defaults each layer’s verdict: blocking → Request changes, drafts → Comment, none → Approve', () => {
    render(SubmitReviewsModal, { props: { reviewId: REVIEW_ID, layers: LAYERS, onclose: () => {} } })
    expect(verdictOf(301)).toBe('request_changes')
    expect(verdictOf(302)).toBe('comment')
    expect(verdictOf(303)).toBe('approve')
  })

  it('warns when a blocking layer is not set to Request changes', async () => {
    render(SubmitReviewsModal, { props: { reviewId: REVIEW_ID, layers: LAYERS, onclose: () => {} } })
    expect(screen.queryByTestId('blocking-mismatch')).toBeNull()
    await fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Verdict for #301' })).getByLabelText('Approve'))
    expect(screen.getByTestId('blocking-mismatch')).toBeInTheDocument()
  })

  it('submits one review per layer with its verdict', async () => {
    render(SubmitReviewsModal, { props: { reviewId: REVIEW_ID, layers: LAYERS, onclose: () => {} } })
    await fireEvent.click(screen.getByRole('button', { name: 'Submit 3 reviews' }))
    expect(api.invoke).toHaveBeenCalledWith('review:submit', {
      reviewId: REVIEW_ID,
      layers: [
        { prUrl: U1, verdict: 'request_changes' },
        { prUrl: U2, verdict: 'comment' },
        { prUrl: U3, verdict: 'approve' },
      ],
    })
    expect(await screen.findAllByText(/Posted/)).toHaveLength(3)
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument()
  })

  it('asks before using a pending review found on GitHub, and retries a failed layer alone', async () => {
    answer = (req) => ({
      layers: req.layers.map((l) =>
        l.prUrl === U1 && !l.adoptPendingReviewId
          ? { prUrl: U1, kind: 'foreign-pending', pendingReviewId: 'PRR_9', commentCount: 2 }
          : l.prUrl === U2
            ? { prUrl: U2, kind: 'failed', error: 'boom' }
            : { prUrl: l.prUrl, kind: 'posted', folded: 0 },
      ),
      complete: false,
    })
    render(SubmitReviewsModal, { props: { reviewId: REVIEW_ID, layers: LAYERS, onclose: () => {} } })
    await fireEvent.click(screen.getByRole('button', { name: 'Submit 3 reviews' }))
    expect(await screen.findByText(/A pending review you started on GitHub exists \(2 comments\)/)).toBeInTheDocument()
    expect(screen.getByText(/Couldn’t post: boom/)).toBeInTheDocument()

    await fireEvent.click(screen.getByRole('button', { name: 'Use it' }))
    expect(api.invoke).toHaveBeenLastCalledWith('review:submit', { reviewId: REVIEW_ID, layers: [{ prUrl: U1, verdict: 'request_changes', adoptPendingReviewId: 'PRR_9' }] })

    answer = (req) => ({ layers: req.layers.map((l) => ({ prUrl: l.prUrl, kind: 'posted', folded: 0 })), complete: true })
    await fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))
    expect(api.invoke).toHaveBeenLastCalledWith('review:submit', { reviewId: REVIEW_ID, layers: [{ prUrl: U2, verdict: 'comment' }] })
  })

  it('leaves out a merged layer by default', () => {
    render(SubmitReviewsModal, { props: { reviewId: REVIEW_ID, layers: [layer(301, U1, { state: 'MERGED' }), layer(302, U2)], onclose: () => {} } })
    expect(screen.getByLabelText('Post a review on #301')).not.toBeChecked()
    expect(screen.getByRole('button', { name: 'Submit 1 review' })).toBeInTheDocument()
  })
})
