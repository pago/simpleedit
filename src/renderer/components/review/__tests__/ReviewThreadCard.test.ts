import { render, screen, fireEvent } from '@testing-library/svelte'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import ReviewThreadCard, { _resetExpandedThreads } from '../ReviewThreadCard.svelte'
import { screenPrsStore } from '../../../stores/screenprs.svelte'
import { _receiveReviewChange, _resetReviewRoomForTests } from '../../../stores/reviewRoom.svelte'
import type { ReviewThread } from '../../../../shared/review-room'
import type { PrReviewComment } from '../../../../shared/screenprs'
import { REVIEW_ID, URL_1, URL_2, layer, msg, stubApi, thread } from './fixtures'

let api: ReturnType<typeof stubApi>

beforeEach(async () => {
  api = stubApi((channel) => (channel === 'agent-threads:retry' ? true : undefined))
  _resetReviewRoomForTests()
  _resetExpandedThreads()
  await screenPrsStore.loadDrafts() // main holds none: the mirror empties
})

const LAYERS = [layer(183, URL_1), layer(184, URL_2)]

function show(t: ReviewThread, opts: { draft?: PrReviewComment; companionSessionId?: string } = {}) {
  return render(ReviewThreadCard, {
    props: {
      reviewId: REVIEW_ID,
      thread: t,
      draftUrl: URL_1,
      layers: LAYERS,
      ...(opts.draft ? { draft: { url: URL_1, comment: opts.draft } } : {}),
      ...(opts.companionSessionId ? { companionSessionId: opts.companionSessionId } : {}),
    },
  })
}

const expanded = (over: Partial<ReviewThread> = {}): ReviewThread =>
  thread({ messages: [msg('tool', 'The retry loop never backs off'), msg('user', 'Is this real?'), msg('companion', 'Yes.')], ...over })

describe('ReviewThreadCard — what it is about', () => {
  it.each([
    [{ kind: 'finding', source: 'triage', key: 'k', preExisting: false } as const, 'S', 'Screening'],
    [{ kind: 'finding', source: 'overview', key: 'k', preExisting: false } as const, 'O', 'Overview'],
    [{ kind: 'finding', source: 'deep', key: 'k', preExisting: false } as const, 'D', 'Deep review'],
    [{ kind: 'finding', source: 'author', key: 'k', preExisting: false } as const, 'A', 'Author'],
    [{ kind: 'github', threadNodeId: 'PRRT_1', rootCommentId: '9', author: 'kim', isResolved: false } as const, 'R', '@kim'],
    [{ kind: 'user' } as const, 'Y', 'You'],
  ])('labels its origin (%o)', (origin, mark, label) => {
    show(expanded({ origin }))
    const badge = screen.getByTestId('origin-badge')
    expect(badge).toHaveTextContent(mark)
    expect(badge).toHaveAttribute('title', label)
  })

  it('shows the finding’s severity as its proposal, and outdated / pre-existing', () => {
    show(expanded({ outdated: true, origin: { kind: 'finding', source: 'deep', key: 'k', severity: 'consider', preExisting: true } }))
    expect(screen.getByText('Deep review suggests: consider')).toBeInTheDocument()
    expect(screen.getByTestId('outdated-badge')).toBeInTheDocument()
    expect(screen.getByTestId('pre-existing-badge')).toBeInTheDocument()
    // Outdated: the original lines are shown, since no row carries it any more.
    expect(screen.getByText('const b = 2')).toBeInTheDocument()
  })

  it('starts an untouched finding collapsed, and opens it on click', async () => {
    show(thread())
    await fireEvent.click(screen.getByTestId('thread-collapsed'))
    expect(screen.getByRole('button', { name: 'Draft comment' })).toBeInTheDocument()
  })

  it('names who said what in the private conversation', () => {
    show(expanded({ origin: { kind: 'github', threadNodeId: 'n', rootCommentId: '1', author: 'kim', isResolved: false }, messages: [msg('reviewer', 'Why not a map?'), msg('user', 'Fact-check this'), msg('companion', 'It holds.')] }))
    expect(screen.getAllByText('@kim').length).toBeGreaterThan(0)
    const convo = screen.getByTestId('conversation')
    expect(convo).toHaveTextContent('You')
    expect(convo).toHaveTextContent('Companion')
    expect(screen.getByRole('button', { name: 'Draft reply' })).toBeInTheDocument()
  })
})

describe('ReviewThreadCard — delivery', () => {
  it.each([
    [{ delivery: 'held', heldReason: 'busy' } as const, "waiting for the agent's turn to end"],
    [{ delivery: 'sending' } as const, 'sending…'],
    [{ delivery: 'delivered' } as const, 'delivered'],
    [{ delivery: 'unanswered' } as const, 'unanswered'],
    [{ delivery: 'failed', failedReason: 'no PTY' } as const, 'failed: no PTY'],
  ])('shows %o', (state, label) => {
    show(expanded({ messages: [msg('tool', 'Item'), msg('user', 'Question?', state)] }), { companionSessionId: 'sess-1' })
    expect(screen.getByTestId('delivery')).toHaveTextContent(label)
  })

  it('retries a failed question through the delivery core, on the companion session', async () => {
    const question = msg('user', 'Question?', { delivery: 'failed' })
    show(expanded({ messages: [msg('tool', 'Item'), question] }), { companionSessionId: 'sess-1' })
    await fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(api.invoke).toHaveBeenCalledWith('agent-threads:retry', 'sess-1', question.id)
  })

  it('can’t retry without a companion', () => {
    show(expanded({ messages: [msg('tool', 'Item'), msg('user', 'Q', { delivery: 'unanswered' })] }))
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDisabled()
  })
})

describe('ReviewThreadCard — asking', () => {
  it('sends a chip as a question in the thread', async () => {
    show(expanded({ messages: [msg('tool', 'Item')] , proposal: undefined }))
    await fireEvent.click(screen.getByTestId('thread-collapsed'))
    await fireEvent.click(screen.getByRole('button', { name: 'Right severity?' }))
    expect(api.ops.at(-1)).toMatchObject({ reviewId: REVIEW_ID, op: { kind: 'append', threadId: 'rt_thread01', message: { body: 'Is consider the right severity?' } } })
  })
})

describe('ReviewThreadCard — the draft', () => {
  it('Draft comment adds a draft linked to the thread, seeded from the finding', async () => {
    show(expanded())
    await fireEvent.click(screen.getByRole('button', { name: 'Draft comment' }))
    const draft = screenPrsStore.draftFor(URL_1).comments
    expect(draft).toHaveLength(1)
    expect(draft[0]).toMatchObject({ threadId: 'rt_thread01', file: 'src/a.ts', line: '2', side: 'RIGHT', sha: 'sha183', severity: 'consider', text: 'The retry loop never backs off' })
  })

  it('a GitHub thread’s draft is a reply to it', async () => {
    show(expanded({ origin: { kind: 'github', threadNodeId: 'PRRT_1', rootCommentId: '42', author: 'kim', isResolved: false } }))
    await fireEvent.click(screen.getByRole('button', { name: 'Draft reply' }))
    expect(screenPrsStore.draftFor(URL_1).comments[0]).toMatchObject({ threadId: 'rt_thread01', inReplyTo: { threadNodeId: 'PRRT_1', rootCommentId: '42' } })
  })

  it('Accept puts the proposal into the draft, creating it if absent, and clears it', async () => {
    show(expanded({ proposal: { text: 'Back off between retries.', severity: 'blocking' } }))
    expect(screen.getByTestId('proposal')).toHaveTextContent('Back off between retries.')
    await fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
    expect(screenPrsStore.draftFor(URL_1).comments[0]).toMatchObject({ threadId: 'rt_thread01', text: 'Back off between retries.', severity: 'blocking' })
    expect(api.ops.at(-1)).toEqual({ reviewId: REVIEW_ID, op: { kind: 'clear-proposal', threadId: 'rt_thread01' } })
  })

  it('Accept updates an existing draft', async () => {
    screenPrsStore.addComment(URL_1, { source: 'you', file: '', text: 'mine', threadId: 'rt_thread01' })
    const existing = screenPrsStore.draftFor(URL_1).comments[0]
    show(expanded({ proposal: { text: 'theirs' } }), { draft: existing })
    await fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
    expect(screenPrsStore.draftFor(URL_1).comments).toEqual([expect.objectContaining({ id: existing.id, text: 'theirs' })])
  })

  it('Keep mine leaves the draft and clears the proposal', async () => {
    screenPrsStore.addComment(URL_1, { source: 'you', file: '', text: 'mine', threadId: 'rt_thread01' })
    const existing = screenPrsStore.draftFor(URL_1).comments[0]
    show(expanded({ proposal: { text: 'theirs' } }), { draft: existing })
    await fireEvent.click(screen.getByRole('button', { name: 'Keep mine' }))
    expect(screenPrsStore.draftFor(URL_1).comments[0].text).toBe('mine')
    expect(api.ops.at(-1)).toEqual({ reviewId: REVIEW_ID, op: { kind: 'clear-proposal', threadId: 'rt_thread01' } })
  })

  it('offers Redraft from conversation once the companion answered', async () => {
    screenPrsStore.addComment(URL_1, { source: 'you', file: '', text: 'mine', threadId: 'rt_thread01' })
    show(expanded(), { draft: screenPrsStore.draftFor(URL_1).comments[0] })
    await fireEvent.click(screen.getByRole('button', { name: 'Redraft from conversation' }))
    expect(api.ops.at(-1)).toMatchObject({ op: { kind: 'append', message: { body: expect.stringContaining('propose_draft') } } })
  })

  it('moves a whole-stack thread’s draft to the picked layer', async () => {
    screenPrsStore.addComment(URL_1, { source: 'you', file: '', text: 'mine', threadId: 'rt_thread01' })
    show(expanded({ anchor: { kind: 'stack' }, origin: { kind: 'user' } }), { draft: screenPrsStore.draftFor(URL_1).comments[0] })
    await fireEvent.change(screen.getByLabelText('Which PR this comment is posted on'), { target: { value: URL_2 } })
    expect(api.invoke).toHaveBeenCalledWith('review:move-draft', 'rt_thread01', URL_2)
  })
})

describe('ReviewThreadCard — done', () => {
  it('closes with a reason', async () => {
    show(expanded())
    await fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Intentional' }))
    expect(api.ops.at(-1)).toEqual({ reviewId: REVIEW_ID, op: { kind: 'set-status', threadId: 'rt_thread01', status: 'done', closeReason: 'intentional' } })
  })

  it('closes without one', async () => {
    show(expanded())
    await fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    await fireEvent.click(screen.getByRole('button', { name: 'No reason' }))
    expect(api.ops.at(-1)).toEqual({ reviewId: REVIEW_ID, op: { kind: 'set-status', threadId: 'rt_thread01', status: 'done' } })
  })

  it('a done thread says why and whether anything posts, and reopens', async () => {
    show(expanded({ status: 'done', closeReason: 'wont-fix' }))
    expect(screen.getByTestId('thread-status')).toHaveTextContent('done · won’t fix · nothing will be posted')
    await fireEvent.click(screen.getByRole('button', { name: 'Reopen' }))
    expect(api.ops.at(-1)).toEqual({ reviewId: REVIEW_ID, op: { kind: 'set-status', threadId: 'rt_thread01', status: 'open' } })
  })
})

describe('ReviewThreadCard — read state', () => {
  it('marks what arrived as read while it is on screen in a focused window', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const t = expanded({ readSeq: 0 })
    _receiveReviewChange({ reviewId: REVIEW_ID, threadId: t.id, thread: t, rev: 1 })
    show(t)
    await vi.waitFor(() => expect(api.ops.find((o) => o.op.kind === 'mark-read')?.op).toEqual({ kind: 'mark-read', threadId: t.id, seq: t.messages.at(-1)?.seq }))
  })

  it('leaves it unread in a background window', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    const t = expanded({ readSeq: 0 })
    _receiveReviewChange({ reviewId: REVIEW_ID, threadId: t.id, thread: t, rev: 1 })
    show(t)
    await new Promise((r) => setTimeout(r, 50))
    expect(api.ops.some((o) => o.op.kind === 'mark-read')).toBe(false)
  })
})

describe('ReviewThreadCard — nothing typed is lost', () => {
  it('saves draft text still in its debounce when the card goes away', async () => {
    screenPrsStore.addComment(URL_1, { source: 'you', file: '', text: 'mine', threadId: 'rt_thread01' })
    const view = show(expanded(), { draft: screenPrsStore.draftFor(URL_1).comments[0] })
    const field = screen.getByLabelText('Your comment')
    await fireEvent.focus(field)
    await fireEvent.input(field, { target: { value: 'mine, edited' } })
    view.unmount()
    expect(screenPrsStore.draftFor(URL_1).comments[0].text).toBe('mine, edited')
  })

  it('Enter while an IME is composing doesn’t send', async () => {
    show(expanded())
    const box = screen.getByLabelText('Ask the companion')
    await fireEvent.input(box, { target: { value: 'にほんご' } })
    await fireEvent.keyDown(box, { key: 'Enter', isComposing: true })
    expect(api.ops.some((o) => o.op.kind === 'append')).toBe(false)
    await fireEvent.keyDown(box, { key: 'Enter' })
    expect(api.ops.some((o) => o.op.kind === 'append')).toBe(true)
  })
})

describe('ReviewThreadCard — a closed review', () => {
  it('is read-only', () => {
    screenPrsStore.addComment(URL_1, { source: 'you', file: '', text: 'mine', threadId: 'rt_thread01' })
    render(ReviewThreadCard, {
      props: { reviewId: REVIEW_ID, thread: expanded({ proposal: { text: 'theirs' } }), draftUrl: URL_1, layers: LAYERS, readonly: true, draft: { url: URL_1, comment: screenPrsStore.draftFor(URL_1).comments[0] } },
    })
    expect(screen.queryByLabelText('Ask the companion')).toBeNull()
    expect(screen.queryByLabelText('Your comment')).toBeNull()
    expect(screen.queryByLabelText('Severity you post')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull()
    expect(screen.getByTestId('draft-box')).toHaveTextContent('mine')
  })
})
