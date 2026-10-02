import { render, screen, fireEvent, waitFor, within } from '@testing-library/svelte'
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import PrDetail from '../PrDetail.svelte'
import { screenPrsStore } from '../../renderer/stores/screenprs.svelte'
import { unknownOutcome, verdictChoice } from '../lib/prs.svelte'
import { NotSentError } from '../api-shim'
import { nav } from '../lib/nav.svelte'
import { tick } from 'svelte'
import type { PrReviewDraft, ScreenPrCard } from '../../shared/screenprs'
import { applyDraftOp, type PrReviewDraftOp } from '../../shared/review-drafts'

/**
 * The one invariant this screen exists to hold:
 *
 *   Nothing reaches `screenprs:submit-review` without the user having seen the
 *   verdict and the comment count and confirmed that exact action.
 *
 * These tests drive the whole path a phone actually takes — tap a line, dictate
 * or type a comment, choose a verdict, submit, confirm — and assert at every
 * step before the confirm that NO write has left the device. `submit-review`
 * posts a real review to a real PR, so this is the only place it is ever
 * exercised, and only against a stub.
 */
const URL_ = 'https://github.com/acme/widgets/pull/7'
const DIFF = [
  'diff --git a/src/gate.ts b/src/gate.ts',
  '--- a/src/gate.ts',
  '+++ b/src/gate.ts',
  '@@ -10,2 +10,2 @@',
  ' const before = 1',
  '+const added = 2',
].join('\n')

const CARD: ScreenPrCard = {
  owner: 'acme', repo: 'acme/widgets', number: 7, url: URL_,
  title: 'Tighten the gate', author: 'dana', updatedAt: '2026-08-01T00:00:00Z',
  headSha: 'sha1', additions: 1, deletions: 0, changedFiles: 1,
  baseRefName: 'main', headRefName: 'feat', ci: 'green', ciFailing: [],
  reviewers: [], approvedByOther: false, body: 'Body text.', diff: '',
  impact: 'low', findings: [], bucket: 'quick',
}

let invoke: ReturnType<typeof vi.fn>
/** Main's side of the drafts, so the store's mirror has something to agree with. */
let mainDrafts: Map<string, PrReviewDraft>
// Never reset: the store is a module singleton and ignores revisions older than one it has seen.
let mainRev = 0
let submitResult: () => Promise<unknown>
let diffResult: () => Promise<string>
/**
 * Releases a deliberately-pending submit.
 *
 * Always called in `afterEach`: the store's `_submitting` set is a module
 * singleton cleared in `submitReview`'s `finally`, so a submit left hanging by
 * one test leaves every later one thinking a post is in flight — four failures
 * pointing at healthy code.
 */
let releasePendingSubmit: () => void = () => {}

function submitCalls(): unknown[][] {
  return invoke.mock.calls.filter(([channel]) => channel === 'screenprs:submit-review')
}

interface SentRequest {
  draft: { comments: { line?: string; sha?: string; text: string }[] }
  headSha?: string
  isolatedBase?: boolean
  clearDraft?: boolean
}

function sentRequest(): SentRequest {
  return (submitCalls()[0] as [string, SentRequest])[1]
}

/**
 * What went to main. With a head attached main re-anchors these before
 * GitHub sees them (its own tests cover that); without one, this is the post.
 *
 * Every anchoring assertion reads this, not the banner. Two rounds of this
 * predicate were wrong in ways a notice-only test could not see: once the
 * notice contradicted the payload, once the notice was deleted and the payload
 * left as it was.
 */
function postedComments(): SentRequest['draft']['comments'] {
  return sentRequest().draft.comments
}

afterEach(() => {
  releasePendingSubmit()
})

/** Choose a verdict and open the confirm, so its contents can be inspected. */
async function openConfirm(verdict: 'approve' | 'comment' | 'request_changes' = 'comment'): Promise<void> {
  await fireEvent.click(screen.getByTestId(`verdict-${verdict}`))
  await fireEvent.click(screen.getByTestId('review-submit'))
}

/** Confirm, and return once the invoke has landed. */
async function confirmPost(): Promise<void> {
  await fireEvent.click(screen.getByTestId('confirm-post'))
  await waitFor(() => expect(submitCalls()).toHaveLength(1))
}

beforeEach(async () => {
  nav.reset()
  mainDrafts = new Map()
  submitResult = async () => ({ ok: true, folded: { count: 0, reasons: {} } })
  diffResult = async () => DIFF
  invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === 'screenprs:pr-diff') return diffResult()
    if (channel === 'stt:status') return { installed: false, binary: null, modelPath: null, modelReady: false, ready: false, hint: 'not installed.' }
    if (channel === 'screenprs:submit-review') return submitResult()
    if (channel === 'screenprs:drafts-load') return { drafts: Object.fromEntries(mainDrafts), rev: ++mainRev }
    if (channel === 'screenprs:draft-op') {
      const { url, op } = args[0] as { url: string; op: PrReviewDraftOp }
      const draft = applyDraftOp(mainDrafts.get(url) ?? null, op)
      if (draft) mainDrafts.set(url, draft)
      else mainDrafts.delete(url)
      return { draft, rev: ++mainRev }
    }
    return undefined
  })
  vi.stubGlobal('api', { invoke, on: () => () => {} })

  // The store and the verdict choice are module singletons; a test must not
  // inherit the previous one's draft.
  screenPrsStore.resetSubmitted(URL_)
  await screenPrsStore.loadDrafts() // main holds none: the mirror empties
  verdictChoice.reset(URL_)
  unknownOutcome.clear(URL_)
  screenPrsStore._onDeepResult(URL_, [], '')
  screenPrsStore._onDeepStatus(URL_, 'idle')
  releasePendingSubmit = () => {}
  screenPrsStore._onQueued([CARD])
  screenPrsStore._onCard(CARD)
})

/** Tap the added line and commit `text` through the compose sheet. */
async function commentOnAddedLine(text: string): Promise<void> {
  await fireEvent.click(screen.getByTestId('pane-files'))
  const rows = await screen.findAllByTestId('diff-line')
  const added = rows.find((el) => el.textContent?.includes('const added = 2'))!
  await fireEvent.click(added)
  const field = screen.getByTestId('composer-text')
  await fireEvent.input(field, { target: { value: text } })
  await fireEvent.click(screen.getByTestId('composer-send'))
  await waitFor(() => expect(screen.queryByTestId('compose-sheet')).toBeNull())
}

describe('PR detail — the path to GitHub', () => {
  it('composes a line comment without any write leaving the device', async () => {
    render(PrDetail, { pr: CARD, connected: true })

    await commentOnAddedLine('this gate is inverted')

    await fireEvent.click(screen.getByTestId('review-toggle'))
    expect(screen.getByTestId('draft-count')).toHaveTextContent('1')
    expect(submitCalls()).toHaveLength(0)
  })

  it('will not submit until a verdict is explicitly chosen', async () => {
    render(PrDetail, { pr: CARD, connected: true })
    await fireEvent.click(screen.getByTestId('review-toggle'))

    // `emptyReviewDraft()` already says `approve`. That must not be enough.
    const submit = screen.getByTestId('review-submit')
    expect(submit).toBeDisabled()
    expect(submit).toHaveTextContent('Choose a verdict first')

    await fireEvent.click(screen.getByTestId('verdict-approve'))
    expect(screen.getByTestId('review-submit')).toBeEnabled()
  })

  it('shows the verdict and the anchored count in a confirm, and only posts on confirm', async () => {
    render(PrDetail, { pr: CARD, connected: true })
    await commentOnAddedLine('this gate is inverted')
    await fireEvent.click(screen.getByTestId('review-toggle'))
    await fireEvent.click(screen.getByTestId('verdict-request_changes'))
    await fireEvent.click(screen.getByTestId('review-submit'))

    expect(screen.getByTestId('confirm-verdict')).toHaveTextContent('Request changes')
    expect(screen.getByTestId('confirm-anchored')).toHaveTextContent('1 line comment anchored')
    expect(submitCalls()).toHaveLength(0)

    await fireEvent.click(screen.getByTestId('confirm-post'))

    await waitFor(() => expect(submitCalls()).toHaveLength(1))
    const [, request] = submitCalls()[0] as [string, { pr: { url: string }; draft: { verdict: string; comments: unknown[] } }]
    expect(request.pr.url).toBe(URL_)
    expect(request.draft.verdict).toBe('request_changes')
    expect(request.draft.comments).toEqual([
      // Stamped with the head its line was read off — see the head-move tests.
      {
        id: expect.any(String),
        source: 'you',
        file: 'src/gate.ts',
        line: '11',
        side: 'RIGHT',
        snippet: 'const added = 2',
        text: 'this gate is inverted',
        sha: 'sha1',
      },
    ])
    await screen.findByTestId('review-submitted')
  })

  it('refuses to post over a closed socket', async () => {
    render(PrDetail, { pr: CARD, connected: false })
    await fireEvent.click(screen.getByTestId('review-toggle'))
    await fireEvent.click(screen.getByTestId('verdict-approve'))
    await fireEvent.click(screen.getByTestId('review-submit'))

    expect(screen.getByTestId('confirm-offline')).toBeInTheDocument()
    expect(screen.getByTestId('confirm-post')).toBeDisabled()
    expect(submitCalls()).toHaveLength(0)
  })

  it('refuses a post that the shim would queue rather than reject', async () => {
    // A socket that closes between the confirm appearing and the tap: the button
    // is disabled, but the enforcement has to be in `post`, because an invoke on
    // a closed socket is buffered and would fire on reconnect.
    const { rerender } = render(PrDetail, { pr: CARD, connected: true })
    await fireEvent.click(screen.getByTestId('review-toggle'))
    await fireEvent.click(screen.getByTestId('verdict-approve'))
    await fireEvent.click(screen.getByTestId('review-submit'))
    await rerender({ pr: CARD, connected: false })

    // Re-enabled by hand to stand in for the race the disabled attribute cannot
    // cover: a tap already on its way when the socket went.
    const post = screen.getByTestId('confirm-post') as HTMLButtonElement
    post.disabled = false
    await fireEvent.click(post)

    expect(submitCalls()).toHaveLength(0)
    expect(screen.getByTestId('confirm-error')).toHaveTextContent('nothing was sent')
  })

  it('calls a dropped connection unknown rather than failed, and does not retry', async () => {
    submitResult = () => Promise.reject(new Error('Connection lost'))
    render(PrDetail, { pr: CARD, connected: true })
    await fireEvent.click(screen.getByTestId('review-toggle'))
    await fireEvent.click(screen.getByTestId('verdict-approve'))
    await fireEvent.click(screen.getByTestId('review-submit'))
    await fireEvent.click(screen.getByTestId('confirm-post'))

    const err = await screen.findByTestId('confirm-error')
    expect(err).toHaveTextContent('isn’t known whether it posted')
    expect(err).toHaveTextContent('acme/widgets#7')
    expect(submitCalls()).toHaveLength(1)
    // Still open, still unsent: the user decides, nothing retries behind them.
    expect(screen.queryByTestId('review-submitted')).toBeNull()
  })

  it('latches after an unknown outcome — posting again takes an acknowledgement', async () => {
    // Reviews have no idempotency key. A post button that re-arms reading
    // exactly as it did on the first attempt, directly under a message saying
    // nobody knows if the first one landed, is how one review becomes two.
    submitResult = () => Promise.reject(new Error('Connection lost'))
    render(PrDetail, { pr: CARD, connected: true })
    await fireEvent.click(screen.getByTestId('review-toggle'))
    await fireEvent.click(screen.getByTestId('verdict-approve'))
    await fireEvent.click(screen.getByTestId('review-submit'))
    await fireEvent.click(screen.getByTestId('confirm-post'))
    await screen.findByTestId('confirm-error')

    expect(screen.getByTestId('confirm-post')).toBeDisabled()
    await fireEvent.click(screen.getByTestId('confirm-post'))
    expect(submitCalls()).toHaveLength(1)

    // And it stays latched across leaving the confirm and coming back — with
    // the reason still on screen. A dead button and no explanation is worse
    // than either alone.
    await fireEvent.click(screen.getByTestId('confirm-cancel'))
    await fireEvent.click(screen.getByTestId('review-submit'))
    expect(screen.getByTestId('confirm-post')).toBeDisabled()
    expect(screen.getByTestId('confirm-error')).toHaveTextContent('isn’t known whether it posted')

    await fireEvent.click(screen.getByTestId('confirm-acknowledge'))
    expect(screen.getByTestId('confirm-post')).toBeEnabled()
  })

  it('does not latch when the call provably never left the device', async () => {
    submitResult = () => Promise.reject(new NotSentError('never sent'))
    render(PrDetail, { pr: CARD, connected: true })
    await fireEvent.click(screen.getByTestId('review-toggle'))
    await fireEvent.click(screen.getByTestId('verdict-approve'))
    await fireEvent.click(screen.getByTestId('review-submit'))
    await fireEvent.click(screen.getByTestId('confirm-post'))

    const err = await screen.findByTestId('confirm-error')
    expect(err).toHaveTextContent('nothing was posted')
    expect(screen.queryByTestId('confirm-acknowledge')).toBeNull()
    expect(screen.getByTestId('confirm-post')).toBeEnabled()
  })

  it('keeps focus inside the dialog once Post is pressed', async () => {
    // Post disables itself and Cancel becomes a paragraph, so the element
    // holding focus disappears mid-write. Left alone, focus falls to <body> —
    // outside the element that owns the key handler — and Tab walks into the
    // board behind while an irreversible write is in flight.
    submitResult = () =>
      new Promise((resolve) => {
        releasePendingSubmit = () => resolve({ ok: true, folded: { count: 0, reasons: {} } })
      })

    render(PrDetail, { pr: CARD, connected: true })
    await fireEvent.click(screen.getByTestId('review-toggle'))
    await fireEvent.click(screen.getByTestId('verdict-approve'))
    await fireEvent.click(screen.getByTestId('review-submit'))

    const dialog = screen.getByTestId('confirm-submit').firstElementChild as HTMLElement
    const postButton = screen.getByTestId('confirm-post') as HTMLButtonElement
    postButton.focus()
    expect(document.activeElement).toBe(postButton)

    await fireEvent.click(postButton)
    await screen.findByTestId('not-cancellable')
    expect(dialog.contains(document.activeElement)).toBe(true)
  })

  it('hands focus back to whatever opened it', async () => {
    render(PrDetail, { pr: CARD, connected: true })
    await fireEvent.click(screen.getByTestId('review-toggle'))
    await fireEvent.click(screen.getByTestId('verdict-approve'))

    const opener = screen.getByTestId('review-submit') as HTMLButtonElement
    opener.focus()
    await fireEvent.click(opener)
    await fireEvent.click(screen.getByTestId('confirm-cancel'))

    await waitFor(() => expect(document.activeElement).toBe(opener))
  })

  it('retries the diff when the connection comes back', async () => {
    // `invoke` refuses rather than queueing while there is no socket, and this
    // effect depends only on the PR and its head — so without reading the
    // connection there is nothing left to re-run the read.
    const moved = { ...CARD, headSha: 'sha-retry' }
    screenPrsStore._onCard(moved)
    diffResult = () => Promise.reject(new Error('Not connected'))

    const { rerender } = render(PrDetail, { pr: CARD, connected: true })
    await fireEvent.click(screen.getByTestId('pane-files'))
    await screen.findByTestId('diff-error')

    diffResult = async () => DIFF
    await rerender({ pr: CARD, connected: false })
    expect(screen.getByTestId('diff-offline')).toBeInTheDocument()

    await rerender({ pr: CARD, connected: true })
    expect(await screen.findAllByTestId('diff-line')).not.toHaveLength(0)
  })

  it('anchors a comment that is verified against the head on screen', async () => {
    render(PrDetail, { pr: CARD, connected: true })
    await commentOnAddedLine('this gate is inverted')
    await fireEvent.click(screen.getByTestId('review-toggle'))

    expect(screen.queryByTestId('moved-notice')).toBeNull()
    expect(screen.queryByTestId('unverified-notice')).toBeNull()
    await openConfirm()
    expect(screen.getByTestId('confirm-anchored')).toHaveTextContent('1 line comment anchored')

    await confirmPost()
    expect(postedComments()[0].line).toBe('11')
    expect(sentRequest()).toMatchObject({ headSha: 'sha1', isolatedBase: false, clearDraft: true })
  })

  it('previews a line outside GitHub’s hunks as folded, as main will post it', async () => {
    render(PrDetail, { pr: CARD, connected: true })
    await commentOnAddedLine('this gate is inverted')
    screenPrsStore.addComment(URL_, { source: 'triage', file: 'src/gate.ts', line: '99', text: 'far away', sha: 'sha1' })
    await fireEvent.click(screen.getByTestId('review-toggle'))
    await openConfirm()
    expect(screen.getByTestId('confirm-anchored')).toHaveTextContent('1 line comment anchored')
    expect(screen.getByTestId('confirm-folded')).toHaveTextContent('1 folded')
    expect(screen.queryByTestId('confirm-unchecked')).toBeNull()
  })

  it('shows a change main refused in the review sheet', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'screenprs:pr-diff') return diffResult()
      if (channel === 'screenprs:draft-op') throw new Error('disk full')
      return undefined
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    render(PrDetail, { pr: CARD, connected: true })
    screenPrsStore.addComment(URL_, { source: 'you', file: 'src/gate.ts', line: '11', text: 'refused', sha: 'sha1' })
    expect(await screen.findByTestId('draft-notice')).toHaveTextContent("couldn't be saved")
    await fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByTestId('draft-notice')).toBeNull()
    vi.restoreAllMocks()
  })

  it('folds an anchor it cannot check rather than posting it', async () => {
    // `screenprs:queued` — which a re-screen started at the DESK delivers here —
    // leaves the head unknown for as long as a `gh pr view` takes. Unverifiable
    // is not the same as verified: on a write other people see, it must fold.
    const { rerender } = render(PrDetail, { pr: CARD, connected: true })
    await commentOnAddedLine('this gate is inverted')

    screenPrsStore._onQueued([CARD])
    await rerender({ pr: CARD, connected: true })

    await fireEvent.click(screen.getByTestId('review-toggle'))
    expect(screen.getByTestId('unverified-notice')).toBeInTheDocument()

    await openConfirm()
    expect(screen.getByTestId('confirm-anchored')).toHaveTextContent('0 line comments anchored')
    expect(screen.getByTestId('confirm-unverified')).toBeInTheDocument()

    await confirmPost()
    expect(sentRequest().headSha).toBeUndefined()
    expect(postedComments()[0].line).toBeUndefined()
    expect(postedComments()[0].text).toBe('this gate is inverted')
  })

  it('folds every sibling when the head moves, not just the one it can see', async () => {
    // Two comments read off the same commit must share a fate. One folding
    // while its sibling posts against the new head is the failure that made the
    // three-state model necessary.
    screenPrsStore._onDeepStatus(URL_, 'done')
    screenPrsStore._onDeepResult(
      URL_,
      [{ lens: 'soundness', severity: 'concern', file: 'src/gate.ts', line: '11', title: 'off by one', detail: 'check the bound' }],
      'sha1',
    )
    const { rerender } = render(PrDetail, { pr: CARD, connected: true })
    await fireEvent.click(screen.getByTestId('add-deep'))
    await commentOnAddedLine('this gate is inverted')

    screenPrsStore._onCard({ ...CARD, headSha: 'sha2' })
    await rerender({ pr: CARD, connected: true })

    await fireEvent.click(screen.getByTestId('review-toggle'))
    expect(screen.getByTestId('moved-notice')).toBeInTheDocument()

    await openConfirm()
    expect(screen.getByTestId('confirm-moved')).toBeInTheDocument()

    // The raw anchors go, pinned to the new head, so main can fold them and
    // say why; it never trusts a line stamped with another commit.
    await confirmPost()
    expect(sentRequest().headSha).toBe('sha2')
    expect(postedComments().map((c) => [c.line, c.sha])).toEqual([['11', 'sha1'], ['11', 'sha1']])
  })

  it('names why comments went into the summary once posted', async () => {
    submitResult = async () => ({ ok: true, folded: { count: 2, reasons: { moved: 2 } } })
    render(PrDetail, { pr: CARD, connected: true })
    await commentOnAddedLine('this gate is inverted')
    await fireEvent.click(screen.getByTestId('review-toggle'))
    await openConfirm()
    await confirmPost()
    expect(await screen.findByTestId('submitted-folds')).toHaveTextContent(
      '2 comments went into the summary instead of on a line: 2 written before the branch moved.'
    )
  })

  it('stamps a lifted finding with the head it was computed against', async () => {
    // The `＋` buttons stay live while the queue is bare, because `_deep`
    // survives `_onQueued`. Stamping the LIVE head there records nothing, and a
    // comment with no stamp can never be shown to have gone stale.
    screenPrsStore._onDeepStatus(URL_, 'done')
    screenPrsStore._onDeepResult(
      URL_,
      [{ lens: 'soundness', severity: 'concern', file: 'src/gate.ts', line: '11', title: 'off by one', detail: 'check the bound' }],
      'sha1',
    )
    screenPrsStore._onQueued([CARD])

    const { rerender } = render(PrDetail, { pr: CARD, connected: true })
    await fireEvent.click(screen.getByTestId('add-deep'))
    expect(screenPrsStore.draftFor(URL_).comments[0].sha).toBe('sha1')

    // Back at the SAME head: the stamp checks out, so it anchors.
    screenPrsStore._onCard(CARD)
    await rerender({ pr: CARD, connected: true })
    await fireEvent.click(screen.getByTestId('review-toggle'))
    await openConfirm()
    await confirmPost()
    expect(postedComments()[0].line).toBe('11')
  })

  it('treats a killed `gh` as unknown, not as a refusal', async () => {
    // A POST the Mac gave up waiting on may still have been received, so this
    // has to latch like a dropped socket rather than read as "nothing happened".
    submitResult = async () => ({ ok: false, error: 'gh api did not finish within 120000ms', delivered: 'unknown' })
    render(PrDetail, { pr: CARD, connected: true })
    await fireEvent.click(screen.getByTestId('review-toggle'))
    await openConfirm('approve')
    await confirmPost()

    const err = await screen.findByTestId('confirm-error')
    expect(err).toHaveTextContent('isn’t known whether the review posted')
    expect(screen.getByTestId('confirm-post')).toBeDisabled()
    expect(screen.getByTestId('confirm-acknowledge')).toBeInTheDocument()
  })

  it('leaves the confirm on Escape even mid-post, and reports the outcome outside it', async () => {
    // A hung `gh` must not seal the reviewer inside a focus trap whose only
    // enabled control is one that does nothing.
    submitResult = () =>
      new Promise((resolve) => {
        releasePendingSubmit = () => resolve({ ok: false, error: 'timed out', delivered: 'unknown' })
      })
    render(PrDetail, { pr: CARD, connected: true })
    await fireEvent.click(screen.getByTestId('review-toggle'))
    await openConfirm('approve')

    const dialog = screen.getByTestId('confirm-submit').firstElementChild as HTMLElement
    await confirmPost()
    await screen.findByTestId('not-cancellable')

    await fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.queryByTestId('confirm-submit')).toBeNull()

    releasePendingSubmit()
    await waitFor(() => expect(screen.getByTestId('sheet-outcome')).toHaveTextContent('isn’t known'))
  })

  it('closes the confirm on Escape', async () => {
    render(PrDetail, { pr: CARD, connected: true })
    await fireEvent.click(screen.getByTestId('review-toggle'))
    await fireEvent.click(screen.getByTestId('verdict-approve'))
    await fireEvent.click(screen.getByTestId('review-submit'))

    await fireEvent.keyDown(screen.getByTestId('confirm-submit').firstElementChild!, { key: 'Escape' })
    expect(screen.queryByTestId('confirm-submit')).toBeNull()
    expect(submitCalls()).toHaveLength(0)
  })

  it('reports a refusal from GitHub as a refusal', async () => {
    submitResult = async () => ({ ok: false, error: 'Can not approve your own pull request' })
    render(PrDetail, { pr: CARD, connected: true })
    await fireEvent.click(screen.getByTestId('review-toggle'))
    await fireEvent.click(screen.getByTestId('verdict-approve'))
    await fireEvent.click(screen.getByTestId('review-submit'))
    await fireEvent.click(screen.getByTestId('confirm-post'))

    const err = await screen.findByTestId('confirm-error')
    expect(err).toHaveTextContent('GitHub refused it: Can not approve your own pull request')
    expect(err).not.toHaveTextContent('isn’t known')
    expect(screen.queryByTestId('confirm-acknowledge')).toBeNull()
  })

  it('lifts a triage finding into the draft with its own provenance', async () => {
    screenPrsStore._onCard({
      ...CARD,
      findings: [{ label: 'issue', file: 'src/gate.ts', line: '11', title: 'inverted condition' }],
    })
    render(PrDetail, { pr: CARD, connected: true })

    await fireEvent.click(screen.getByTestId('add-triage'))
    await fireEvent.click(screen.getByTestId('review-toggle'))

    expect(screen.getByTestId('draft-count')).toHaveTextContent('1')
    // Scoped: the Files pane stays mounted, and its diff tags the comment too.
    expect(within(screen.getByTestId('review-sheet')).getByText('triage')).toBeInTheDocument()
    expect(submitCalls()).toHaveLength(0)
  })

  // Back is a swipe away on a phone; a comment that has not been added yet
  // exists nowhere but in this sheet.
  it('asks before Back throws away a typed line comment', async () => {
    render(PrDetail, { pr: CARD, connected: true })
    await fireEvent.click(screen.getByTestId('pane-files'))
    const rows = await screen.findAllByTestId('diff-line')
    await fireEvent.click(rows.find((el) => el.textContent?.includes('const added = 2'))!)
    await fireEvent.input(screen.getByTestId('composer-text'), { target: { value: 'half a thought' } })

    nav.back()
    await tick()
    expect(screen.getByTestId('compose-discard-confirm')).toBeInTheDocument()
    expect(screen.getByTestId('composer-text')).toHaveValue('half a thought')

    await fireEvent.click(screen.getByTestId('compose-discard-confirmed'))
    expect(screen.queryByTestId('compose-sheet')).toBeNull()
    expect(nav.stack()).toEqual([])
  })

  it('lets Back close an empty line comment without asking', async () => {
    render(PrDetail, { pr: CARD, connected: true })
    await fireEvent.click(screen.getByTestId('pane-files'))
    const rows = await screen.findAllByTestId('diff-line')
    await fireEvent.click(rows.find((el) => el.textContent?.includes('const added = 2'))!)

    nav.back()
    await tick()
    expect(screen.queryByTestId('compose-sheet')).toBeNull()
    expect(screen.queryByTestId('compose-discard-confirm')).toBeNull()
  })

  /** Every `update-comment` op the phone sent to main. */
  function updateOps(): PrReviewDraftOp[] {
    return invoke.mock.calls
      .filter(([ch]) => ch === 'screenprs:draft-op')
      .map(([, req]) => (req as { op: PrReviewDraftOp }).op)
      .filter((op) => op.kind === 'update-comment')
  }

  it('edits a draft comment by tapping it under its line', async () => {
    render(PrDetail, { pr: CARD, connected: true })
    await commentOnAddedLine('this gate is inverted')
    await fireEvent.click(await screen.findByTestId('inline-comment'))

    const field = screen.getByTestId('composer-text')
    expect(field).toHaveValue('this gate is inverted')
    await fireEvent.input(field, { target: { value: 'this gate is backwards' } })
    await fireEvent.click(screen.getByTestId('composer-send'))
    await waitFor(() => expect(screen.queryByTestId('compose-sheet')).toBeNull())

    const id = mainDrafts.get(URL_)!.comments[0].id
    expect(updateOps()).toEqual([{ kind: 'update-comment', id, patch: { text: 'this gate is backwards' } }])
    await waitFor(() => expect(screen.getByTestId('inline-comment')).toHaveTextContent('this gate is backwards'))
    expect(mainDrafts.get(URL_)!.comments).toHaveLength(1)
  })

  it('lets Back leave an unchanged edit without asking, and asks once it changed', async () => {
    render(PrDetail, { pr: CARD, connected: true })
    await commentOnAddedLine('this gate is inverted')

    await fireEvent.click(await screen.findByTestId('inline-comment'))
    nav.back()
    await tick()
    expect(screen.queryByTestId('compose-sheet')).toBeNull()
    expect(screen.queryByTestId('compose-discard-confirm')).toBeNull()

    await fireEvent.click(screen.getByTestId('inline-comment'))
    await fireEvent.input(screen.getByTestId('composer-text'), { target: { value: 'second thoughts' } })
    nav.back()
    await tick()
    expect(screen.getByTestId('compose-discard-confirm')).toBeInTheDocument()
    await fireEvent.click(screen.getByTestId('compose-discard-confirmed'))
    expect(updateOps()).toEqual([])
    expect(screen.getByTestId('inline-comment')).toHaveTextContent('this gate is inverted')
  })

  it('deletes a draft comment from its edit sheet', async () => {
    render(PrDetail, { pr: CARD, connected: true })
    await commentOnAddedLine('this gate is inverted')
    await fireEvent.click(await screen.findByTestId('inline-comment'))
    await fireEvent.click(screen.getByTestId('compose-delete'))

    expect(screen.queryByTestId('compose-sheet')).toBeNull()
    await waitFor(() => expect(screen.queryByTestId('inline-comment')).toBeNull())
    expect(mainDrafts.get(URL_)?.comments ?? []).toHaveLength(0)
    expect(nav.stack()).toEqual([])
  })

  it('will not let Back take the confirm away while a post is in flight', async () => {
    submitResult = () =>
      new Promise((resolve) => {
        releasePendingSubmit = () => resolve({ ok: true, folded: { count: 0, reasons: {} } })
      })
    render(PrDetail, { pr: CARD, connected: true })
    await fireEvent.click(screen.getByTestId('review-toggle'))
    await openConfirm()
    await confirmPost()

    nav.back()
    await tick()
    expect(screen.getByTestId('confirm-submit')).toBeInTheDocument()

    releasePendingSubmit()
    await waitFor(() => expect(screen.queryByTestId('confirm-submit')).toBeNull())
    expect(nav.stack()).toEqual([])
  })
})

describe('PR detail — overview', () => {
  const TEXT = '## What changed\nTightens it.\n## Why\nB\n## Impact\nC\n## Look into\n1. Is the gate inverted? `src/gate.ts:11`'

  beforeEach(() => {
    screenPrsStore._onOverviewStatus(URL_, 'idle')
  })

  function showOverview(): void {
    screenPrsStore._onOverviewResult(URL_, 'sha1', TEXT, { draft: false, changeset: 'no' })
    screenPrsStore._onOverviewStatus(URL_, 'done')
  }

  it('starts with the fetched diff re-attached, as deep review does', async () => {
    render(PrDetail, { pr: CARD, connected: true })
    await waitFor(() => expect(screen.getByTestId('run-overview')).toBeEnabled())
    await fireEvent.click(screen.getByTestId('run-overview'))
    const call = invoke.mock.calls.find(([ch]) => ch === 'screenprs:overview-start')
    expect(call?.[1]).toMatchObject({ url: URL_, diff: DIFF })
  })

  it('opens What changed and keeps the other sections collapsed', async () => {
    showOverview()
    render(PrDetail, { pr: CARD, connected: true })
    expect(screen.getByTestId('overview-section-what')).toHaveTextContent('Tightens it.')
    expect(screen.getByTestId('overview-section-lookInto')).not.toHaveTextContent('inverted')
    expect(screen.queryByTestId('overview-discuss')).toBeNull()
  })

  it('switches to Files and lands on the cited line', async () => {
    showOverview()
    vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {})
    render(PrDetail, { pr: CARD, connected: true })
    await waitFor(() => expect(screen.getByTestId('run-overview')).toBeEnabled()) // diff fetched
    await fireEvent.click(within(screen.getByTestId('overview-section-lookInto')).getByRole('button'))
    await fireEvent.click(screen.getByTestId('overview-ref'))
    await waitFor(() => expect(document.querySelector('[data-revealed]')).toHaveAttribute('data-line', '11'))
    expect(screen.getByTestId('pane-files')).toHaveAttribute('aria-pressed', 'true')
    vi.restoreAllMocks()
  })

  it('＋ review lifts an item into the draft as a question, stamped with its head', async () => {
    showOverview()
    render(PrDetail, { pr: CARD, connected: true })
    await waitFor(() => expect(screen.getByTestId('run-overview')).toBeEnabled())
    await fireEvent.click(within(screen.getByTestId('overview-section-lookInto')).getByRole('button'))
    await fireEvent.click(screen.getByTestId('overview-add-review'))
    expect(screenPrsStore.draftFor(URL_).comments).toEqual([
      { id: expect.any(String), source: 'overview', file: 'src/gate.ts', line: '11', text: 'question: Is the gate inverted? `src/gate.ts:11`', sha: 'sha1' },
    ])
  })
})

describe('PR detail — base warning', () => {
  it('warns when GitHub’s diff includes a lower stack layer it could not isolate', async () => {
    const polluted: ScreenPrCard = {
      ...CARD,
      baseRefName: 'lower',
      base: { kind: 'polluted', foreign: 3, behindBy: 0, own: [{ sha: 'sha1', subject: 'mine' }], isolated: false },
    }
    screenPrsStore._onQueued([polluted])
    screenPrsStore._onCard(polluted)
    render(PrDetail, { pr: polluted, connected: true })

    expect(await screen.findByTestId('base-warning')).toHaveTextContent(
      "Misleading diff on GitHub: includes 3 commits from lower (base rebased). Couldn't isolate this PR's commits; the diff below includes the lower layer."
    )
  })

  it('contrasts GitHub’s file count with the isolated diff’s', async () => {
    const isolated: ScreenPrCard = {
      ...CARD,
      baseRefName: 'lower',
      changedFiles: 4,
      base: {
        kind: 'polluted', basePr: 6, foreign: 3, behindBy: 2, own: [{ sha: 'sha1', subject: 'mine' }], isolated: true,
        github: { additions: 80, deletions: 9, changedFiles: 12 },
      },
    }
    screenPrsStore._onQueued([isolated])
    screenPrsStore._onCard(isolated)
    render(PrDetail, { pr: isolated, connected: true })

    expect(await screen.findByTestId('base-warning')).toHaveTextContent(
      "Misleading diff on GitHub: includes 3 commits from #6 (base rebased, behind by 2). GitHub shows 12 files; this PR's own 1 commit touch 4. Showing only those."
    )
  })

  it('says nothing for a PR on the default branch', () => {
    render(PrDetail, { pr: CARD, connected: true })
    expect(screen.queryByTestId('base-warning')).toBeNull()
  })
})
