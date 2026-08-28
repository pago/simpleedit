import { render, screen, fireEvent, waitFor } from '@testing-library/svelte'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import PrDetail from '../PrDetail.svelte'
import { screenPrsStore } from '../../renderer/stores/screenprs.svelte'
import { verdictChoice } from '../lib/prs.svelte'
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

function submitCalls(): unknown[][] {
  return invoke.mock.calls.filter(([channel]) => channel === 'screenprs:submit-review')
}

beforeEach(() => {
  submitResult = async () => ({ ok: true, foldedComments: false })
  invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === 'screenprs:pr-diff') return DIFF
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
      { source: 'you', file: 'src/gate.ts', line: '11', text: 'this gate is inverted' },
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

  it('calls a dropped connection unknown rather than failed, and does not retry', async () => {
    submitResult = () => Promise.reject(new Error('Connection lost'))
    render(PrDetail, { pr: CARD, connected: true })
    await fireEvent.click(screen.getByTestId('review-toggle'))
    await fireEvent.click(screen.getByTestId('verdict-approve'))
    await fireEvent.click(screen.getByTestId('review-submit'))
    await fireEvent.click(screen.getByTestId('confirm-post'))

    const err = await screen.findByTestId('confirm-error')
    expect(err).toHaveTextContent('isn’t known whether the review was posted')
    expect(err).toHaveTextContent('acme/widgets#7')
    expect(submitCalls()).toHaveLength(1)
    // Still open, still unsent: the user decides, nothing retries behind them.
    expect(screen.queryByTestId('review-submitted')).toBeNull()
  })

  it('reports a refusal from GitHub as a refusal', async () => {
    submitResult = async () => ({ ok: false, error: 'Can not approve your own pull request' })
    render(PrDetail, { pr: CARD, connected: true })
    await fireEvent.click(screen.getByTestId('review-toggle'))
    await fireEvent.click(screen.getByTestId('verdict-approve'))
    await fireEvent.click(screen.getByTestId('review-submit'))
    await fireEvent.click(screen.getByTestId('confirm-post'))

    const err = await screen.findByTestId('confirm-error')
    expect(err).toHaveTextContent('Can not approve your own pull request')
    expect(err).not.toHaveTextContent('isn’t known')
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
