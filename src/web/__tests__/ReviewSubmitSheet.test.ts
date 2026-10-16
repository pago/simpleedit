import { render, screen, fireEvent, waitFor } from '@testing-library/svelte'
import { describe, it, expect, beforeEach } from 'vitest'
import ReviewSubmitSheet from '../ReviewSubmitSheet.svelte'
import { ConnectionLostError, NotSentError } from '../api-shim'
import { reviewSubmits } from '../lib/review-phone.svelte'
import { screenPrsStore } from '../../renderer/stores/screenprs.svelte'
import { _receiveReviewChange, _resetReviewRoomForTests, reviewRoom } from '../../renderer/stores/reviewRoom.svelte'
import { DIFF_TRUNCATED_MARKER } from '../../shared/ipc-types'
import type { ReviewSubmitRequest, ReviewSubmitResult } from '../../shared/review-room-ipc'
import { REVIEW_ID, layer, review, stubApi, thread } from '../../renderer/components/review/__tests__/fixtures'

const U1 = 'https://github.com/acme/app/pull/401'
const U2 = 'https://github.com/acme/app/pull/402'
const LAYERS = [layer(401, U1), layer(402, U2)]

let api: ReturnType<typeof stubApi>
let answer: (req: ReviewSubmitRequest) => ReviewSubmitResult | Promise<ReviewSubmitResult>
let diffs: Record<string, string>
let rev = 50_000

function submits(): ReviewSubmitRequest[] {
  return api.invoke.mock.calls.filter(([c]) => c === 'review:submit').map(([, req]) => req as ReviewSubmitRequest)
}

function mount(props: Partial<{ requesterLive: boolean; connected: boolean }> = {}) {
  return render(ReviewSubmitSheet, { props: { reviewId: REVIEW_ID, layers: LAYERS, requesterLive: false, connected: true, onclose: () => {}, ...props } })
}

beforeEach(async () => {
  answer = (req) => ({ layers: req.layers.map((l) => ({ prUrl: l.prUrl, kind: 'posted', folded: 0 })), complete: true })
  diffs = { [U1]: '', [U2]: '' }
  api = stubApi((channel, ...args) => {
    if (channel === 'review:submit') return answer(args[0] as ReviewSubmitRequest)
    if (channel === 'review:layer-diff') return { url: args[1], headSha: `sha${String(args[1]).split('/').pop()}`, diff: diffs[String(args[1])] }
    return undefined
  })
  reviewSubmits._reset()
  await screenPrsStore.loadDrafts()
  _resetReviewRoomForTests()
  _receiveReviewChange({ reviewId: REVIEW_ID, review: review(), rev: ++rev })
  _receiveReviewChange({ reviewId: REVIEW_ID, threadId: 'rt_block01', thread: thread({ id: 'rt_block01' }), rev: ++rev })
  screenPrsStore.addComment(U1, { source: 'you', file: '', text: 'Must fix', severity: 'blocking', threadId: 'rt_block01' })
})

async function loadDiffs(): Promise<void> {
  await Promise.all(LAYERS.map((l) => reviewRoom.loadLayerDiff(REVIEW_ID, l.url)))
}

describe('ReviewSubmitSheet', () => {
  it('is a modal sheet', async () => {
    await loadDiffs()
    mount()
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true')
  })

  it('defaults each layer’s verdict from its drafts and posts it at the head read', async () => {
    await loadDiffs()
    mount()
    expect(screen.getAllByTestId('verdict-request_changes')[0]).toHaveAttribute('aria-checked', 'true')
    expect(screen.getAllByTestId('verdict-approve')[1]).toHaveAttribute('aria-checked', 'true')
    await fireEvent.click(screen.getByTestId('submit-reviews'))
    await waitFor(() => expect(submits()).toHaveLength(1))
    expect(submits()[0]).toEqual({
      reviewId: REVIEW_ID,
      layers: [
        { prUrl: U1, verdict: 'request_changes', readHead: 'sha401' },
        { prUrl: U2, verdict: 'approve', readHead: 'sha402' },
      ],
      destination: { session: false, github: true },
    })
  })

  it('keeps a layer whose diff was cut for the phone out: it was not read in full', async () => {
    diffs[U2] = `diff --git a/x b/x\n${DIFF_TRUNCATED_MARKER}\n`
    await loadDiffs()
    mount()
    expect(screen.getByTestId('submit-unread')).toHaveTextContent('post this layer at the desk')
    await fireEvent.click(screen.getByTestId('submit-reviews'))
    await waitFor(() => expect(submits()).toHaveLength(1))
    expect(submits()[0].layers.map((l) => l.prUrl)).toEqual([U1])
  })

  it('sends it back to a live requesting session by default', async () => {
    _receiveReviewChange({ reviewId: REVIEW_ID, review: review({ requesterSessionId: 'agent-claude-req' }), rev: ++rev })
    await loadDiffs()
    mount({ requesterLive: true })
    expect(screen.getByTestId('send-to-session')).toBeChecked()
    expect(screen.getByTestId('post-to-github')).not.toBeChecked()
    await fireEvent.click(screen.getByTestId('submit-reviews'))
    await waitFor(() => expect(submits()).toHaveLength(1))
    expect(submits()[0].destination).toEqual({ session: true, github: false })
  })

  it('latches when the answer never came back, and shows what the Mac recorded', async () => {
    answer = () => {
      throw new ConnectionLostError('socket closed')
    }
    await loadDiffs()
    mount()
    await fireEvent.click(screen.getByTestId('submit-reviews'))
    await waitFor(() => expect(screen.getByTestId('submit-latched')).toBeInTheDocument())
    expect(reviewSubmits.latched(REVIEW_ID)).toBe(true)
    expect(screen.getByTestId('submit-reviews')).toBeDisabled()

    // Meanwhile main broadcasts how far it got.
    _receiveReviewChange({
      reviewId: REVIEW_ID,
      review: review({ submissions: [{ at: 'now', destination: { session: false, github: true }, layers: [{ prUrl: U1, verdict: 'request_changes', postedCommentIds: [], state: 'posted' }] }] }),
      rev: ++rev,
    })
    await waitFor(() => expect(screen.getByTestId('submit-recorded')).toHaveTextContent('#401: posted'))

    await fireEvent.click(screen.getByTestId('submit-acknowledge'))
    expect(screen.getByTestId('submit-reviews')).not.toBeDisabled()
  })

  it('does not latch a submit that provably never left the phone', async () => {
    answer = () => {
      throw new NotSentError('offline')
    }
    await loadDiffs()
    mount()
    await fireEvent.click(screen.getByTestId('submit-reviews'))
    await waitFor(() => expect(screen.getByTestId('submit-error')).toHaveTextContent('nothing was posted'))
    expect(reviewSubmits.latched(REVIEW_ID)).toBe(false)
  })

  it('shows main’s refusal without latching: nothing was posted', async () => {
    answer = () => {
      throw new Error('This review is already being submitted')
    }
    await loadDiffs()
    mount()
    await fireEvent.click(screen.getByTestId('submit-reviews'))
    await waitFor(() => expect(screen.getByTestId('submit-error')).toHaveTextContent('already being submitted'))
    expect(reviewSubmits.latched(REVIEW_ID)).toBe(false)
  })

  it('keeps the latch for the tab, so a reload doesn’t re-arm Submit', () => {
    reviewSubmits.latch(REVIEW_ID)
    expect(JSON.parse(sessionStorage.getItem('simpleedit.reviewSubmitLatch') ?? '[]')).toEqual([REVIEW_ID])
    reviewSubmits.unlatch(REVIEW_ID)
    expect(sessionStorage.getItem('simpleedit.reviewSubmitLatch')).toBeNull()
  })

  it('takes one submit for a double tap while the review body is still being saved', async () => {
    await loadDiffs()
    mount()
    const button = screen.getByTestId('submit-reviews')
    await Promise.all([fireEvent.click(button), fireEvent.click(button)])
    await waitFor(() => expect(submits()).toHaveLength(1))
  })

  it('posts a layer whose diff only quotes the truncation marker', async () => {
    diffs[U2] = `diff --git a/x b/x\n+const M = '${DIFF_TRUNCATED_MARKER}'\n context\n`
    await loadDiffs()
    mount()
    await fireEvent.click(screen.getByTestId('submit-reviews'))
    await waitFor(() => expect(submits()).toHaveLength(1))
    expect(submits()[0].layers.map((l) => l.prUrl)).toEqual([U1, U2])
  })

  it('holds Back while the answer is owed', async () => {
    let finish: (r: ReviewSubmitResult) => void = () => {}
    answer = () => new Promise((resolve) => (finish = resolve))
    await loadDiffs()
    const { component } = mount()
    await fireEvent.click(screen.getByTestId('submit-reviews'))
    await waitFor(() => expect(reviewSubmits.inFlight(REVIEW_ID)).toBe(true))
    expect(component.holdForDraft()).toBe(true)
    finish({ layers: [], complete: false })
    await waitFor(() => expect(component.holdForDraft()).toBe(false))
  })
})
