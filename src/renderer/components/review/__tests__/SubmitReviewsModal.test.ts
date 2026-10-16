import { render, screen, fireEvent, within } from '@testing-library/svelte'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import SubmitReviewsModal from '../SubmitReviewsModal.svelte'
import { screenPrsStore } from '../../../stores/screenprs.svelte'
import { _receiveReviewChange, _resetReviewRoomForTests, reviewRoom } from '../../../stores/reviewRoom.svelte'
import type { ReviewSubmitRequest, ReviewSubmitResult } from '../../../../shared/review-room-ipc'
import { REVIEW_ID, layer, stubApi, thread } from './fixtures'

const U1 = 'https://github.com/acme/app/pull/301'
const U2 = 'https://github.com/acme/app/pull/302'
const U3 = 'https://github.com/acme/app/pull/303'
const LAYERS = [layer(301, U1), layer(302, U2), layer(303, U3)]

let api: ReturnType<typeof stubApi>
let answer: (req: ReviewSubmitRequest) => ReviewSubmitResult

beforeEach(async () => {
  answer = (req) => ({ layers: req.layers.map((l) => ({ prUrl: l.prUrl, kind: 'posted', folded: 0 })), complete: true })
  api = stubApi((channel, ...args) => {
    if (channel === 'review:submit') return answer(args[0] as ReviewSubmitRequest)
    if (channel === 'review:layer-diff') return { url: args[1], headSha: 'read302', diff: '' }
    return undefined
  })
  await screenPrsStore.loadDrafts()
  _resetReviewRoomForTests()
  for (const id of ['rt_blocking1', 'rt_consider1']) _receiveReviewChange({ reviewId: REVIEW_ID, threadId: id, thread: thread({ id }), rev: 1 })
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
        { prUrl: U1, verdict: 'request_changes', readHead: 'sha301' },
        { prUrl: U2, verdict: 'comment', readHead: 'sha302' },
        { prUrl: U3, verdict: 'approve', readHead: 'sha303' },
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
    expect(api.invoke).toHaveBeenLastCalledWith('review:submit', { reviewId: REVIEW_ID, layers: [{ prUrl: U1, verdict: 'request_changes', readHead: 'sha301', adoptPendingReviewId: 'PRR_9' }] })

    answer = (req) => ({ layers: req.layers.map((l) => ({ prUrl: l.prUrl, kind: 'posted', folded: 0 })), complete: true })
    await fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))
    expect(api.invoke).toHaveBeenLastCalledWith('review:submit', { reviewId: REVIEW_ID, layers: [{ prUrl: U2, verdict: 'comment', readHead: 'sha302' }] })
  })

  it('sends the head of the diff on screen, which may be older than the layer’s latest', async () => {
    await reviewRoom.loadLayerDiff(REVIEW_ID, U2)
    render(SubmitReviewsModal, { props: { reviewId: REVIEW_ID, layers: [layer(302, U2)], onclose: () => {} } })
    await fireEvent.click(screen.getByRole('button', { name: 'Submit 1 review' }))
    expect(api.invoke).toHaveBeenLastCalledWith('review:submit', { reviewId: REVIEW_ID, layers: [{ prUrl: U2, verdict: 'comment', readHead: 'read302' }] })
  })

  it('says a layer that moved since it was read was not posted, and offers no retry', async () => {
    answer = (req) => ({ layers: req.layers.map((l) => ({ prUrl: l.prUrl, kind: 'head-moved', readHead: l.readHead, headSha: 'abcdef1234' })), complete: false })
    render(SubmitReviewsModal, { props: { reviewId: REVIEW_ID, layers: [layer(301, U1)], onclose: () => {} } })
    await fireEvent.click(screen.getByRole('button', { name: 'Submit 1 review' }))
    expect(await screen.findByTestId('submit-head-moved')).toHaveTextContent('moved to abcdef1')
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Submit 0 reviews' })).toBeDisabled()
  })

  it('leaves out a merged layer by default', () => {
    render(SubmitReviewsModal, { props: { reviewId: REVIEW_ID, layers: [layer(301, U1, { state: 'MERGED' }), layer(302, U2)], onclose: () => {} } })
    expect(screen.getByLabelText('Post a review on #301')).not.toBeChecked()
    expect(screen.getByRole('button', { name: 'Submit 1 review' })).toBeInTheDocument()
  })
})

describe('SubmitReviewsModal — what main posts', () => {
  it('lists, counts and defaults on this review’s thread drafts only', () => {
    screenPrsStore.addComment(U3, { source: 'you', file: '', text: 'Old composer note', severity: 'blocking' })
    screenPrsStore.addComment(U3, { source: 'you', file: '', text: 'Another review’s', severity: 'blocking', threadId: 'rt_otherrev' })
    render(SubmitReviewsModal, { props: { reviewId: REVIEW_ID, layers: LAYERS, onclose: () => {} } })
    expect(verdictOf(303)).toBe('approve')
    expect(screen.queryByText('Old composer note')).toBeNull()
    expect(screen.queryByText('Another review’s')).toBeNull()
  })

  it('shows the review body it posts, and sends an edit before submitting', async () => {
    screenPrsStore.setSummary(U1, 'Overall: nearly there.')
    render(SubmitReviewsModal, { props: { reviewId: REVIEW_ID, layers: LAYERS, onclose: () => {} } })
    const body = screen.getByLabelText('Review body for #301')
    expect(body).toHaveValue('Overall: nearly there.')
    await fireEvent.input(body, { target: { value: 'Overall: fix the loop.' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Submit 3 reviews' }))
    await vi.waitFor(() => expect(api.invoke).toHaveBeenCalledWith('review:submit', expect.anything()))
    const calls = api.invoke.mock.calls.map((c) => c[0] === 'screenprs:draft-op' ? `op:${JSON.stringify((c[1] as { op: unknown }).op)}` : c[0])
    const summaryAt = calls.lastIndexOf(`op:${JSON.stringify({ kind: 'set-summary', summary: 'Overall: fix the loop.' })}`)
    expect(summaryAt).toBeGreaterThan(-1)
    expect(summaryAt).toBeLessThan(calls.indexOf('review:submit'))
  })
})

describe('SubmitReviewsModal — focus', () => {
  it('takes focus, keeps Tab inside, closes on Esc from within, and gives focus back', async () => {
    const opener = document.createElement('button')
    opener.textContent = 'Submit reviews…'
    document.body.append(opener)
    opener.focus()
    let closed = false
    const view = render(SubmitReviewsModal, { props: { reviewId: REVIEW_ID, layers: LAYERS, onclose: () => (closed = true) } })
    const dialog = screen.getByRole('dialog')
    await vi.waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))

    const submit = screen.getByRole('button', { name: 'Submit 3 reviews' })
    submit.focus()
    await fireEvent.keyDown(submit, { key: 'Tab' })
    expect(dialog.contains(document.activeElement)).toBe(true)
    expect(document.activeElement).not.toBe(submit)
    const first = document.activeElement
    await fireEvent.keyDown(first as Element, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(submit)

    await fireEvent.keyDown(screen.getByLabelText('Review body for #301'), { key: 'Escape' })
    expect(closed).toBe(true)
    view.unmount()
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })
})
