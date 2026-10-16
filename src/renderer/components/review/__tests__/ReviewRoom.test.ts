import { render, screen, fireEvent, within } from '@testing-library/svelte'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import ReviewRoom from '../ReviewRoom.svelte'
import { _receiveReviewChange, _resetReviewRoomForTests, reviewRoom } from '../../../stores/reviewRoom.svelte'
import { screenPrsStore } from '../../../stores/screenprs.svelte'
import type { ReviewThread } from '../../../../shared/review-room'
import { REVIEW_ID, URL_1, URL_2, layer, msg, review, stubApi, thread } from './fixtures'

vi.mock('../../terminal/Terminal.svelte', async () => ({ default: (await import('./StubTerminal.svelte')).default }))

const DIFF = ['diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,2 +1,3 @@', ' const a = 1', '+const b = 2', ' const c = 3'].join('\n')

let api: ReturnType<typeof stubApi>

beforeEach(async () => {
  _resetReviewRoomForTests()
  api = stubApi((channel, ...args) => {
    if (channel === 'review:open') return { reviewId: REVIEW_ID, layers: [layer(183, URL_1, { headSha: 'sha183' }), layer(184, URL_2, { headSha: 'sha184' })] }
    if (channel === 'review:layer-diff') return { url: args[1], headSha: args[1] === URL_1 ? 'sha183' : 'sha184', diff: DIFF }
    if (channel === 'review:since') return args[1] === URL_2 ? { kind: 'ahead', aheadBy: 2, from: 'a', to: 'b' } : { kind: 'first-visit' }
    if (channel === 'review:companion-info') return null
    return undefined
  })
  await screenPrsStore.loadDrafts()
  await reviewRoom.open(URL_1)
  _receiveReviewChange({ reviewId: REVIEW_ID, review: review(), rev: 1 })
})

function addThread(t: ReviewThread): void {
  _receiveReviewChange({ reviewId: REVIEW_ID, threadId: t.id, thread: t, rev: 1 })
}

describe('ReviewRoom', () => {
  it('shows the stack, each layer and the bars, bottom to top', async () => {
    render(ReviewRoom, { props: { reviewId: REVIEW_ID } })
    expect(screen.getByTestId('stack-section')).toHaveTextContent('#183 → #184')
    expect(screen.getAllByTestId('layer-section')).toHaveLength(2)
    expect(screen.getAllByTestId('stack-layer').map((b) => b.textContent)).toEqual([expect.stringContaining('#183'), expect.stringContaining('#184')])
    expect(screen.getByTestId('post-bar')).toHaveTextContent('#183: 0 to post')
    expect(screen.getByTestId('companion-dock')).toBeInTheDocument()
    expect(await screen.findByTestId('since-banner')).toHaveTextContent('2 new commits since you last looked')
  })

  it('puts a line thread under its row, and an outdated one at the layer top', async () => {
    addThread(thread({ id: 'rt_online01', messages: [msg('tool', 'On the line'), msg('user', 'q')] }))
    addThread(thread({ id: 'rt_outdat01', outdated: true, anchor: { kind: 'line', pr: 183, headSha: 'older', path: 'src/a.ts', side: 'RIGHT', startLine: 2, endLine: 2, snippet: 'x', before: '', after: '' }, messages: [msg('tool', 'Was here'), msg('user', 'q')] }))
    render(ReviewRoom, { props: { reviewId: REVIEW_ID } })
    const first = screen.getAllByTestId('layer-section')[0]
    const card = (id: string): Element | null => first.querySelector(`[data-thread-card="${id}"]`)
    await within(first).findByRole('button', { name: 'Comment on line 2' }) // the diff is in
    // Under the diff row (inside the diff view), not in the layer header.
    expect(card('rt_online01')?.closest('.font-mono')).not.toBeNull()
    expect(card('rt_outdat01')?.closest('.font-mono')).toBeNull()
  })

  it('a click on a line starts a thread: Draft comment adds a draft-only thread and its draft', async () => {
    render(ReviewRoom, { props: { reviewId: REVIEW_ID } })
    const first = screen.getAllByTestId('layer-section')[0]
    const plus = await within(first).findByRole('button', { name: 'Comment on line 2' })
    await fireEvent.click(plus)
    await fireEvent.input(within(first).getByLabelText('New thread'), { target: { value: 'Name this better' } })
    await fireEvent.click(within(first).getByRole('button', { name: 'Draft comment' }))
    await vi.waitFor(() => expect(screenPrsStore.draftFor(URL_1).comments).toHaveLength(1))
    const op = api.ops.at(-1)?.op
    expect(op).toMatchObject({ kind: 'add-thread', thread: { anchor: { kind: 'line', pr: 183, headSha: 'sha183', path: 'src/a.ts', side: 'RIGHT', startLine: 2, endLine: 2, snippet: 'const b = 2', before: 'const a = 1', after: 'const c = 3' } } })
    expect(op).not.toHaveProperty('message')
    const id = op && 'thread' in op ? op.thread.id : ''
    expect(screenPrsStore.draftFor(URL_1).comments[0]).toMatchObject({ threadId: id, file: 'src/a.ts', line: '2', text: 'Name this better', sha: 'sha183' })
  })

  it('Ask companion starts the thread with the question', async () => {
    render(ReviewRoom, { props: { reviewId: REVIEW_ID } })
    const first = screen.getAllByTestId('layer-section')[0]
    await fireEvent.click(await within(first).findByRole('button', { name: 'Comment on line 2' }))
    await fireEvent.input(within(first).getByLabelText('New thread'), { target: { value: 'What calls this?' } })
    await fireEvent.click(within(first).getByRole('button', { name: 'Ask companion' }))
    await vi.waitFor(() => expect(api.ops.at(-1)?.op).toMatchObject({ kind: 'add-thread', message: { body: 'What calls this?' } }))
  })

  it('Ask about the stack starts a whole-stack thread', async () => {
    render(ReviewRoom, { props: { reviewId: REVIEW_ID } })
    await fireEvent.click(screen.getByRole('button', { name: 'Ask about the stack' }))
    await fireEvent.input(within(screen.getByTestId('stack-section')).getByLabelText('New thread'), { target: { value: 'Is the split right?' } })
    await fireEvent.click(within(screen.getByTestId('stack-section')).getByRole('button', { name: 'Ask companion' }))
    await vi.waitFor(() => expect(api.ops.at(-1)?.op).toMatchObject({ kind: 'add-thread', thread: { anchor: { kind: 'stack' } } }))
  })

  it('Submit reviews opens the dialog', async () => {
    render(ReviewRoom, { props: { reviewId: REVIEW_ID } })
    await fireEvent.click(screen.getByRole('button', { name: 'Submit reviews…' }))
    expect(screen.getByRole('dialog', { name: 'Submit reviews' })).toBeInTheDocument()
  })

  it('a tour step ticks as read', async () => {
    screenPrsStore._onOverviewResult(URL_1, 'sha183', '## What changed\nA\n## Why\nB\n## Impact\nC\n## Reading order\n1. **The constant** — read it `src/a.ts:2`\n## Look into\n1. Q `src/a.ts:2`', { draft: false, changeset: 'no' })
    screenPrsStore._onOverviewStatus(URL_1, 'done')
    render(ReviewRoom, { props: { reviewId: REVIEW_ID } })
    const first = screen.getAllByTestId('layer-section')[0]
    expect(await within(first).findByTestId('tour-step')).toHaveTextContent('The constant')
    await fireEvent.click(within(first).getByRole('button', { name: 'Mark “The constant” as read' }))
    expect(api.invoke).toHaveBeenCalledWith('review:mark-step', REVIEW_ID, '183:0:the-constant', true)
    screenPrsStore._onOverviewStatus(URL_1, 'idle')
  })
})
