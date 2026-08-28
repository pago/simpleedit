import { render, screen, fireEvent, waitFor } from '@testing-library/svelte'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import PrDetail from '../PrDetail.svelte'
import { screenPrsStore } from '../../renderer/stores/screenprs.svelte'
import { unknownOutcome, verdictChoice } from '../lib/prs.svelte'
import { NotSentError } from '../api-shim'
import type { ScreenPrCard } from '../../shared/screenprs'

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
let submitResult: () => Promise<unknown>
let diffResult: () => Promise<string>

function submitCalls(): unknown[][] {
  return invoke.mock.calls.filter(([channel]) => channel === 'screenprs:submit-review')
}

beforeEach(() => {
  submitResult = async () => ({ ok: true, foldedComments: false })
  diffResult = async () => DIFF
  invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === 'screenprs:pr-diff') return diffResult()
    if (channel === 'stt:status') return { installed: false, binary: null, modelPath: null, modelReady: false, ready: false, hint: 'not installed.' }
    if (channel === 'screenprs:submit-review') return submitResult()
    void args
    return undefined
  })
  vi.stubGlobal('api', { invoke, on: () => () => {} })

  // The store and the verdict choice are module singletons; a test must not
  // inherit the previous one's draft.
  screenPrsStore.resetSubmitted(URL_)
  verdictChoice.reset(URL_)
  unknownOutcome.clear(URL_)
  screenPrsStore._onDeepResult(URL_, [])
  screenPrsStore._onDeepStatus(URL_, 'idle')
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
      { source: 'you', file: 'src/gate.ts', line: '11', text: 'this gate is inverted', sha: 'sha1' },
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

  it('un-anchors a comment when the branch moves under it', async () => {
    // The reviews API carries no `commit_id`: GitHub anchors against whatever
    // the head is at POST time. A comment written at sha1 and posted at sha2
    // would land on whatever now occupies line 11 — no 422, no fold, no warning.
    const { rerender } = render(PrDetail, { pr: CARD, connected: true })
    await commentOnAddedLine('this gate is inverted')

    screenPrsStore._onCard({ ...CARD, headSha: 'sha2' })
    await rerender({ pr: CARD, connected: true })

    await fireEvent.click(screen.getByTestId('review-toggle'))
    expect(screen.getByTestId('stale-notice')).toBeInTheDocument()

    await fireEvent.click(screen.getByTestId('verdict-comment'))
    await fireEvent.click(screen.getByTestId('review-submit'))
    expect(screen.getByTestId('confirm-anchored')).toHaveTextContent('0 line comments anchored')
    expect(screen.getByTestId('confirm-folded')).toHaveTextContent('1 folded into the summary')

    await fireEvent.click(screen.getByTestId('confirm-post'))
    await waitFor(() => expect(submitCalls()).toHaveLength(1))
    const [, request] = submitCalls()[0] as [string, { draft: { comments: { line?: string }[] } }]
    expect(request.draft.comments[0].line).toBeUndefined()
  })

  it('does not call a comment stale while the head is merely unknown', async () => {
    // `screenprs:queued` replaces every entry with a bare ref — a re-screen
    // started at the DESK reaches the phone as one — so `context`, and with it
    // `headSha`, is gone until this PR's metadata comes back: a `gh pr view`
    // and a `gh pr checks` away, seconds to minutes.
    //
    // Unknown is not the same as different. Reading it as different made the
    // confirm say "1 line comment anchored" and "1 was written against an
    // earlier commit" in the same box, while posting the anchor anyway.
    const { rerender } = render(PrDetail, { pr: CARD, connected: true })
    await commentOnAddedLine('this gate is inverted')

    screenPrsStore._onQueued([CARD])
    await rerender({ pr: CARD, connected: true })

    await fireEvent.click(screen.getByTestId('review-toggle'))
    expect(screen.queryByTestId('stale-notice')).toBeNull()

    await fireEvent.click(screen.getByTestId('verdict-comment'))
    await fireEvent.click(screen.getByTestId('review-submit'))
    expect(screen.queryByTestId('confirm-stale')).toBeNull()
    expect(screen.getByTestId('confirm-anchored')).toHaveTextContent('1 line comment anchored')

    await fireEvent.click(screen.getByTestId('confirm-post'))
    await waitFor(() => expect(submitCalls()).toHaveLength(1))
    const [, request] = submitCalls()[0] as [string, { draft: { comments: { line?: string }[] } }]
    // What the confirm counted is what went: the head never moved.
    expect(request.draft.comments[0].line).toBe('11')
  })

  it('stamps nothing rather than "" when a finding is lifted with the head unknown', async () => {
    // `_deep` survives `_onQueued`, so these ＋ buttons are live in that window.
    // A comment stamped `''` there is stale against every real head forever:
    // anchor dropped, user told the branch moved, nothing having moved.
    screenPrsStore._onDeepStatus(URL_, 'done')
    screenPrsStore._onDeepResult(URL_, [
      { lens: 'soundness', severity: 'concern', file: 'src/gate.ts', line: '11', title: 'off by one', detail: 'check the bound' },
    ])
    screenPrsStore._onQueued([CARD])

    const { rerender } = render(PrDetail, { pr: CARD, connected: true })
    await fireEvent.click(screen.getByTestId('add-deep'))

    screenPrsStore._onCard(CARD)
    await rerender({ pr: CARD, connected: true })

    await fireEvent.click(screen.getByTestId('review-toggle'))
    expect(screen.queryByTestId('stale-notice')).toBeNull()
    expect(screen.getByTestId('draft-count')).toHaveTextContent('1')
  })

  it('keeps focus inside the dialog once Post is pressed', async () => {
    // Post disables itself and Cancel becomes a paragraph, so the element
    // holding focus disappears mid-write. Left alone, focus falls to <body> —
    // outside the element that owns the key handler — and Tab walks into the
    // board behind while an irreversible write is in flight.
    let release: (value: unknown) => void = () => {}
    submitResult = () => new Promise((resolve) => { release = resolve })

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

    release({ ok: true, foldedComments: false })
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
    expect(screen.getByText('triage')).toBeInTheDocument()
    expect(submitCalls()).toHaveLength(0)
  })
})
