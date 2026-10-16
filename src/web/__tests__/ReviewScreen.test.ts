import { render, screen, fireEvent, waitFor, within } from '@testing-library/svelte'
import { describe, it, expect, beforeEach } from 'vitest'
import ReviewScreen from '../ReviewScreen.svelte'
import { _resetRoomThreads } from '../RoomThreadCard.svelte'
import { nav } from '../lib/nav.svelte'
import { companionState, initCompanionStatusListener, reviewSubmits } from '../lib/review-phone.svelte'
import { screenPrsStore } from '../../renderer/stores/screenprs.svelte'
import { _receiveReviewChange, _resetReviewRoomForTests } from '../../renderer/stores/reviewRoom.svelte'
import type { ReviewCompanionInfo } from '../../shared/review-room-ipc'
import type { ReviewOp } from '../../shared/review-room'
import { REVIEW_ID, URL_1, URL_2, layer, msg, review, stubApi, thread } from '../../renderer/components/review/__tests__/fixtures'

const DIFF = ['diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,2 +1,3 @@', ' const a = 1', '+const b = 2', ' const c = 3', ''].join('\n')
const COMPANION = { sessionId: 'agent-claude-comp01', windowId: 2, agent: { provider: 'claude', model: '' }, claimRequestId: 'q' }

let api: ReturnType<typeof stubApi>
let companionInfo: ReviewCompanionInfo | null
let rev = 70_000

function mount(props: Partial<{ hostBlocked: string | null; connected: boolean }> = {}) {
  return render(ReviewScreen, { props: { url: URL_1, connected: true, visible: true, hostBlocked: null, ...props } })
}

beforeEach(async () => {
  companionInfo = null
  api = stubApi((channel, ...args) => {
    if (channel === 'review:open') return { reviewId: REVIEW_ID, layers: [layer(183, URL_1), layer(184, URL_2)] }
    if (channel === 'review:layer-diff') return { url: args[1], headSha: args[1] === URL_1 ? 'sha183' : 'sha184', diff: args[1] === URL_1 ? DIFF : '' }
    if (channel === 'review:since') return { kind: 'identical' }
    if (channel === 'review:companion-info') return companionInfo
    return undefined
  })
  initCompanionStatusListener()
  nav.reset()
  nav.selectTab('prs')
  companionState._reset()
  reviewSubmits._reset()
  _resetRoomThreads()
  await screenPrsStore.loadDrafts()
  _resetReviewRoomForTests()
  _receiveReviewChange({ reviewId: REVIEW_ID, review: review(), rev: ++rev })
})

function addThread(over: Parameters<typeof thread>[0]): void {
  _receiveReviewChange({ reviewId: REVIEW_ID, threadId: over?.id ?? 'rt_thread01', thread: thread(over), rev: ++rev })
}

describe('ReviewScreen', () => {
  it('opens the stack and shows every layer as one page, with no terminal', async () => {
    mount()
    await waitFor(() => expect(screen.getAllByTestId('room-layer')).toHaveLength(2))
    expect(api.invoke).toHaveBeenCalledWith('review:open', URL_1)
    expect(screen.getByTestId('stack-section')).toBeInTheDocument()
    expect(document.querySelector('.xterm')).toBeNull()
  })

  it('puts a line thread under the row it ends on', async () => {
    addThread({ id: 'rt_line0001', origin: { kind: 'user' }, messages: [msg('user', 'Why two?')] })
    mount()
    const [diff] = await screen.findAllByTestId('room-diff')
    const card = await within(diff).findByTestId('room-thread')
    // The row above the card is the anchored line 2.
    const row = card.closest('li')?.querySelector('[data-testid="diff-line"]')
    expect(row).toHaveAttribute('data-line', '2')
  })

  it('starts a thread with the user’s own comment from a tapped line', async () => {
    mount()
    const [diff] = await screen.findAllByTestId('room-diff')
    const line = within(diff).getAllByTestId('diff-line').find((r) => r.getAttribute('data-line') === '2')!
    await fireEvent.click(line)
    const composer = await screen.findByTestId('room-composer')
    await fireEvent.input(within(composer).getByRole('textbox'), { target: { value: 'Name this better' } })
    await fireEvent.click(within(composer).getByTestId('composer-draft'))
    await waitFor(() => expect(api.ops).toHaveLength(1))
    const op = api.ops[0].op as ReviewOp
    expect(op).toMatchObject({ kind: 'add-thread', thread: { anchor: { kind: 'line', pr: 183, path: 'src/a.ts', side: 'RIGHT', startLine: 2, endLine: 2, snippet: 'const b = 2' } } })
    expect('message' in op).toBe(false)
    const threadId = op.kind === 'add-thread' ? op.thread.id : ''
    await waitFor(() => expect(screenPrsStore.draftFor(URL_1).comments).toMatchObject([{ text: 'Name this better', threadId, line: '2', sha: 'sha183' }]))
  })

  it('turns Ask off with the reason when no companion runs and this window can’t host one', async () => {
    addThread({ id: 'rt_pr000001', anchor: { kind: 'pr', pr: 183 }, origin: { kind: 'user' }, messages: [msg('user', 'Hm')] })
    mount({ hostBlocked: 'No project open in that window.' })
    const card = await screen.findByTestId('room-thread')
    expect(within(card).getByTestId('ask-blocked')).toHaveTextContent('No project open')
    await fireEvent.input(within(card).getByRole('textbox', { name: 'Ask the companion' }), { target: { value: 'Is it safe?' } })
    expect(within(card).getByTestId('ask')).toBeDisabled()
  })

  it('asks through main when a companion runs in another window, and says when it needs you', async () => {
    _receiveReviewChange({ reviewId: REVIEW_ID, review: review({ companion: COMPANION }), rev: ++rev })
    companionInfo = { reviewId: REVIEW_ID, sessionId: COMPANION.sessionId, windowId: 2, hostedHere: false, live: true, readOnly: 'enforced', status: 'running' }
    addThread({ id: 'rt_pr000002', anchor: { kind: 'pr', pr: 183 }, origin: { kind: 'user' }, messages: [msg('user', 'Hm')] })
    mount({ hostBlocked: 'No project open in that window.' })
    await waitFor(() => expect(screen.getByTestId('companion-line')).toHaveTextContent('working'))
    const card = screen.getByTestId('room-thread')
    await fireEvent.input(within(card).getByRole('textbox', { name: 'Ask the companion' }), { target: { value: 'Is it safe?' } })
    await fireEvent.click(within(card).getByTestId('ask'))
    await waitFor(() => expect(api.ops.at(-1)?.op).toMatchObject({ kind: 'append', threadId: 'rt_pr000002', message: { body: 'Is it safe?' } }))

    api.emit('review:companion-status', { reviewId: REVIEW_ID, sessionId: COMPANION.sessionId, status: 'waiting' })
    await waitFor(() => expect(screen.getByTestId('companion-line')).toHaveTextContent('answer on the Mac'))
  })

  it('opens the outline over the room, and a pick closes it', async () => {
    addThread({ id: 'rt_pr000003', anchor: { kind: 'pr', pr: 183 }, origin: { kind: 'user' }, messages: [msg('user', 'Look here')] })
    mount()
    await fireEvent.click(await screen.findByTestId('open-outline'))
    const sheet = await screen.findByTestId('outline-sheet')
    expect(nav.top()?.kind).toBe('review-outline')
    await fireEvent.click(within(sheet).getByTestId('outline-item'))
    await waitFor(() => expect(screen.queryByTestId('outline-sheet')).toBeNull())
  })

  it('reads nothing that a sheet covers', async () => {
    addThread({ id: 'rt_pr000004', anchor: { kind: 'pr', pr: 183 }, origin: { kind: 'user' }, messages: [msg('user', 'Q'), msg('companion', 'A')], readSeq: 0 })
    mount()
    await fireEvent.click(await screen.findByTestId('open-outline'))
    await screen.findByTestId('outline-sheet')
    api.ops.length = 0
    await new Promise((r) => setTimeout(r, 100))
    expect(api.ops.filter((o) => o.op.kind === 'mark-read')).toEqual([])
    nav.back()
    await waitFor(() => expect(api.ops.some((o) => o.op.kind === 'mark-read')).toBe(true))
  })

  it('says why it can’t open while offline', () => {
    mount({ connected: false })
    expect(screen.getByTestId('room-loading')).toHaveTextContent('Waiting for the connection')
    expect(api.invoke).not.toHaveBeenCalledWith('review:open', URL_1)
  })
})
