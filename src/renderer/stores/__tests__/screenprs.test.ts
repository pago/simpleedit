import { describe, it, expect, beforeEach, vi } from 'vitest'
import { screenPrsStore, initScreenPrsListeners } from '../screenprs.svelte'
import type { EventMap } from '../../../shared/ipc-types'
import { bucketOf, emptyReviewDraft, type ScreenPrCard, type PrContext, type PrReviewDraft } from '../../../shared/screenprs'
import { applyDraftOp, type DraftOpResult, type PrReviewDraftOp } from '../../../shared/review-drafts'

type Handlers = {
  'screenprs:queued'?: (d: EventMap['screenprs:queued']) => void
  'screenprs:screening'?: (d: EventMap['screenprs:screening']) => void
  'screenprs:card'?: (d: EventMap['screenprs:card']) => void
  'screenprs:status'?: (d: EventMap['screenprs:status']) => void
  'screenprs:deep-lens'?: (d: EventMap['screenprs:deep-lens']) => void
  'screenprs:deep-result'?: (d: EventMap['screenprs:deep-result']) => void
  'screenprs:deep-status'?: (d: EventMap['screenprs:deep-status']) => void
  'screenprs:overview-result'?: (d: EventMap['screenprs:overview-result']) => void
  'screenprs:overview-status'?: (d: EventMap['screenprs:overview-status']) => void
  'screenprs:draft-changed'?: (d: EventMap['screenprs:draft-changed']) => void
}

let handlers: Handlers
let dispose: () => void

function ctx(over: Partial<PrContext> & { number: number; url: string }): PrContext {
  return {
    owner: 'acme', repo: 'ui', title: 't', author: 'a', updatedAt: '2026-07-01',
    headSha: 'sha1', additions: 10, deletions: 1, changedFiles: 1, baseRefName: 'main',
    // Unique per PR so no two fixtures accidentally stack (groupStacks matches
    // one card's baseRefName against another's headRefName).
    headRefName: `pr-${over.number}`,
    ci: 'green', ciFailing: [], reviewers: [], approvedByOther: false, body: '', diff: '',
    ...over,
  }
}
function card(c: PrContext, impact: ScreenPrCard['impact'], findings: ScreenPrCard['findings'] = []): ScreenPrCard {
  return { ...c, impact, findings, bucket: bucketOf({ ...c, impact, findings }) }
}

beforeEach(async () => {
  handlers = {}
  vi.stubGlobal('api', {
    on: (channel: string, cb: (d: unknown) => void) => {
      ;(handlers as Record<string, unknown>)[channel] = cb
      return () => { delete (handlers as Record<string, unknown>)[channel] }
    },
    once: vi.fn(),
    invoke: vi.fn(async (channel: string) => (channel === 'screenprs:drafts-load' ? { drafts: {}, rev: 0 } : undefined)),
  })
  await screenPrsStore.start() // resets entries/selection/status
  dispose = initScreenPrsListeners()
})

describe('screenPrsStore ingestion', () => {
  it('seeds a queued placeholder, then screening, then the final card', () => {
    const c = ctx({ number: 1, url: 'u1' })
    handlers['screenprs:queued']!({ refs: [c] })
    expect(screenPrsStore.pending().map((p) => p.ref.url)).toEqual(['u1'])
    expect(screenPrsStore.pending()[0].context).toBeUndefined()
    expect(screenPrsStore.total()).toBe(1)

    handlers['screenprs:screening']!({ context: c })
    expect(screenPrsStore.pending()[0].context?.url).toBe('u1')
    expect(screenPrsStore.byBucket().quick).toHaveLength(0)

    handlers['screenprs:card']!({ card: card(c, 'low') })
    expect(screenPrsStore.pending()).toHaveLength(0)
    expect(screenPrsStore.byBucket().quick.map((x) => x.url)).toEqual(['u1'])
  })

  it('routes cards into buckets and counts attention', () => {
    const a = ctx({ number: 1, url: 'a', ci: 'failing', ciFailing: ['e2e'] })
    const b = ctx({ number: 2, url: 'b' })
    const c = ctx({ number: 3, url: 'c', approvedByOther: true })
    handlers['screenprs:card']!({ card: card(a, 'low') })            // waiting (CI red)
    handlers['screenprs:card']!({ card: card(b, 'high') })           // attention
    handlers['screenprs:card']!({ card: card(c, 'low') })            // fyi (approved, not critical)

    const bk = screenPrsStore.byBucket()
    expect(bk.waiting.map((x) => x.url)).toEqual(['a'])
    expect(bk.attention.map((x) => x.url)).toEqual(['b'])
    expect(bk.fyi.map((x) => x.url)).toEqual(['c'])
    expect(screenPrsStore.attentionCount()).toBe(1)
  })

  it('tracks run status + total', () => {
    handlers['screenprs:status']!({ status: 'done', total: 5 })
    expect(screenPrsStore.status()).toBe('done')
    expect(screenPrsStore.total()).toBe(5)
  })

  it('a later card for the same PR replaces the placeholder (no dupes)', () => {
    const c = ctx({ number: 7, url: 'u7' })
    handlers['screenprs:screening']!({ context: c })
    handlers['screenprs:card']!({ card: card(c, 'high') })
    handlers['screenprs:card']!({ card: card(c, 'high') })
    expect(screenPrsStore.entries()).toHaveLength(1)
    expect(screenPrsStore.byBucket().attention).toHaveLength(1)
  })

  it('tracks deep-review lens progress, result, and status by url', () => {
    handlers['screenprs:deep-status']!({ url: 'u1', status: 'running' })
    handlers['screenprs:deep-lens']!({ url: 'u1', lens: 'soundness', status: 'running' })
    handlers['screenprs:deep-lens']!({ url: 'u1', lens: 'soundness', status: 'done' })
    handlers['screenprs:deep-result']!({
      url: 'u1',
      findings: [{ lens: 'soundness', severity: 'blocking', file: 'a.ts', title: 'npe', detail: 'guard' }],
      headSha: 'sha1',
    })
    handlers['screenprs:deep-status']!({ url: 'u1', status: 'done' })

    const d = screenPrsStore.deepFor('u1')
    expect(d?.status).toBe('done')
    expect(d?.lenses.soundness).toBe('done')
    expect(d?.findings).toHaveLength(1)
    // Kept, not discarded: a finding's line numbers are meaningless without the
    // commit they were computed against, and a comment lifted from one is
    // stamped with THIS, not with whatever head happens to be live at the tap.
    expect(d?.headSha).toBe('sha1')
    // A different PR is unaffected.
    expect(screenPrsStore.deepFor('other')).toBeUndefined()
  })

  it('tracks an overview by url: running on start, then the raw text, facts and head', async () => {
    const c = ctx({ number: 3, url: 'u3', headSha: 'sha3', diff: 'the diff' })
    await screenPrsStore.startOverview(c)
    expect(screenPrsStore.overviewFor('u3')).toMatchObject({ status: 'running', headSha: 'sha3' })
    const invoke = (window.api.invoke as ReturnType<typeof vi.fn>).mock.calls.find(([ch]) => ch === 'screenprs:overview-start')
    // A plain object, diff included: a $state proxy can't cross IPC.
    expect(invoke?.[1]).toEqual(c)

    handlers['screenprs:overview-result']!({ url: 'u3', headSha: 'sha3', text: '## What changed\nA', facts: { draft: false, changeset: 'no' } })
    handlers['screenprs:overview-status']!({ url: 'u3', status: 'done' })
    expect(screenPrsStore.overviewFor('u3')).toEqual({
      status: 'done', text: '## What changed\nA', facts: { draft: false, changeset: 'no' }, headSha: 'sha3', error: undefined,
    })
    expect(screenPrsStore.overviewFor('other')).toBeUndefined()
  })

  it('settles a cancelled overview locally, since main sends nothing for it', async () => {
    await screenPrsStore.startOverview(ctx({ number: 4, url: 'u4' }))
    await screenPrsStore.cancelOverview('u4')
    expect(screenPrsStore.overviewFor('u4')?.status).toBe('idle')
    expect(window.api.invoke).toHaveBeenCalledWith('screenprs:overview-cancel', 'u4')
  })

  it('unsubscribes cleanly', () => {
    dispose()
    expect(handlers['screenprs:card']).toBeUndefined()
    expect(handlers['screenprs:deep-status']).toBeUndefined()
    expect(handlers['screenprs:overview-result']).toBeUndefined()
  })
})

describe('screenPrsStore draft mirror', () => {
  // The store is a module singleton that ignores revisions older than one it
  // has seen, so every test uses its own url and revisions only ever rise.
  let rev = 1_000
  const next = (): number => ++rev
  const draft = (over: Partial<PrReviewDraft>): PrReviewDraft => ({ ...emptyReviewDraft(), ...over })

  /** Each `draft-op` waits until the test answers it, as main would — later. */
  let replies: ((res: DraftOpResult) => void)[]
  let opCalls: { url: string; op: { kind: string } }[]
  beforeEach(() => {
    replies = []
    opCalls = []
    vi.mocked(window.api.invoke).mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'screenprs:draft-op') {
        opCalls.push(args[0] as { url: string; op: { kind: string } })
        return new Promise<DraftOpResult>((resolve) => replies.push(resolve))
      }
      return undefined
    })
  })

  it('takes a change made on another client', () => {
    handlers['screenprs:draft-changed']!({ url: 'd1', draft: draft({ summary: 'from the phone' }), rev: next() })
    expect(screenPrsStore.draftFor('d1').summary).toBe('from the phone')
    handlers['screenprs:draft-changed']!({ url: 'd1', draft: null, rev: next() })
    expect(screenPrsStore.draftFor('d1')).toEqual(emptyReviewDraft())
  })

  it('ignores a state older than one it already has', () => {
    const late = next()
    handlers['screenprs:draft-changed']!({ url: 'd2', draft: draft({ summary: 'newer' }), rev: next() })
    handlers['screenprs:draft-changed']!({ url: 'd2', draft: draft({ summary: 'older' }), rev: late })
    expect(screenPrsStore.draftFor('d2').summary).toBe('newer')
  })

  it('mints an id per comment and sends it to main', () => {
    screenPrsStore.addComment('d3', { source: 'you', file: 'a.ts', line: '1', text: 'x' })
    const [c] = screenPrsStore.draftFor('d3').comments
    expect(c.id).toEqual(expect.any(String))
    expect(opCalls).toEqual([{ url: 'd3', op: { kind: 'add-comment', comment: c } }])
  })

  it('does not let a state that predates its own op undo it', async () => {
    screenPrsStore.addComment('d4', { source: 'you', file: 'a.ts', line: '1', text: 'mine' })
    const mine = screenPrsStore.draftFor('d4')
    // Another client's change, applied by main before ours arrived.
    handlers['screenprs:draft-changed']!({ url: 'd4', draft: draft({ verdict: 'comment' }), rev: next() })
    expect(screenPrsStore.draftFor('d4').comments).toEqual(mine.comments)

    replies[0]({ draft: { ...mine, verdict: 'comment' }, rev: next() })
    await vi.waitFor(() => expect(screenPrsStore.draftFor('d4').verdict).toBe('comment'))
    expect(screenPrsStore.draftFor('d4').comments).toEqual(mine.comments)
  })

  it('removes and updates a comment by id', () => {
    screenPrsStore.addComment('d5', { source: 'you', file: 'a.ts', line: '1', text: 'one' })
    screenPrsStore.addComment('d5', { source: 'you', file: 'a.ts', line: '2', text: 'two' })
    const [one, two] = screenPrsStore.draftFor('d5').comments
    screenPrsStore.updateComment('d5', two.id, { text: 'two, edited' })
    screenPrsStore.removeComment('d5', one.id)
    expect(screenPrsStore.draftFor('d5').comments).toEqual([{ ...two, text: 'two, edited' }])
    expect(opCalls.slice(2).map((c) => c.op)).toEqual([
      { kind: 'update-comment', id: two.id, patch: { text: 'two, edited' } },
      { kind: 'remove-comment', id: one.id },
    ])
  })

  it('keeps summary text still being typed here over an incoming change, then sends it', async () => {
    vi.useFakeTimers()
    try {
      screenPrsStore.setSummary('d6', 'half a sent')
      expect(opCalls).toEqual([]) // debounced
      handlers['screenprs:draft-changed']!({ url: 'd6', draft: draft({ summary: 'stale', verdict: 'comment' }), rev: next() })
      expect(screenPrsStore.draftFor('d6')).toMatchObject({ summary: 'half a sent', verdict: 'comment' })

      screenPrsStore.setSummary('d6', 'half a sentence')
      vi.advanceTimersByTime(400)
      expect(opCalls).toEqual([{ url: 'd6', op: { kind: 'set-summary', summary: 'half a sentence' } }])
    } finally {
      vi.useRealTimers()
    }
  })

  it('loads every draft main holds', async () => {
    const snapshot = { drafts: { d7: draft({ summary: 'persisted' }) }, rev: next() }
    vi.mocked(window.api.invoke).mockImplementation(async (channel: string, ..._args: unknown[]) =>
      channel === 'screenprs:drafts-load' ? snapshot : undefined
    )
    await screenPrsStore.loadDrafts()
    expect(screenPrsStore.draftFor('d7').summary).toBe('persisted')
  })

  it('keeps everything typed when a submit does not ask to clear the draft', async () => {
    vi.useFakeTimers()
    try {
      handlers['screenprs:draft-changed']!({ url: 'd9', draft: draft({ summary: 'stored' }), rev: next() })
      screenPrsStore.setSummary('d9', 'still typing')
      vi.mocked(window.api.invoke).mockImplementation(async (channel: string, ...args: unknown[]) => {
        if (channel === 'screenprs:submit-review') return { ok: true, folded: { count: 0, reasons: {} } }
        if (channel === 'screenprs:draft-op') opCalls.push(args[0] as { url: string; op: { kind: string } })
        return undefined
      })
      const pr = { owner: 'acme', repo: 'ui', number: 9, url: 'd9' }
      await screenPrsStore.submitReview(pr, { ...emptyReviewDraft(), verdict: 'approve' }, { headSha: 'sha1' })
      expect(vi.mocked(window.api.invoke)).toHaveBeenCalledWith('screenprs:submit-review', expect.not.objectContaining({ clearDraft: true }))
      expect(screenPrsStore.submittedFor('d9')).toMatchObject({ verdict: 'approve' })
      expect(screenPrsStore.submittedFor('d9')?.draftCleared).toBeFalsy()
      expect(screenPrsStore.draftFor('d9').summary).toBe('still typing')

      vi.advanceTimersByTime(400)
      screenPrsStore.resetSubmitted('d9')
      expect(screenPrsStore.draftFor('d9').summary).toBe('still typing')
      expect(opCalls).toEqual([{ url: 'd9', op: { kind: 'set-summary', summary: 'still typing' } }])
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves a posted draft for main to clear, keeping what was added mid-post', async () => {
    handlers['screenprs:draft-changed']!({ url: 'd8', draft: draft({ summary: 's' }), rev: next() })
    const posted = screenPrsStore.draftFor('d8')
    let stored: PrReviewDraft | null = posted
    vi.mocked(window.api.invoke).mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'screenprs:submit-review') return { ok: true, folded: { count: 0, reasons: {} } }
      if (channel === 'screenprs:draft-op') {
        const call = args[0] as { url: string; op: PrReviewDraftOp }
        opCalls.push(call)
        stored = applyDraftOp(stored, call.op)
        return { draft: stored, rev: next() }
      }
      return undefined
    })
    const pr = { owner: 'acme', repo: 'ui', number: 8, url: 'd8' }
    const submitting = screenPrsStore.submitReview(pr, posted, { clearDraft: true })
    screenPrsStore.addComment('d8', { source: 'you', file: 'a.ts', line: '3', text: 'while posting' })
    await submitting
    expect(vi.mocked(window.api.invoke)).toHaveBeenCalledWith('screenprs:submit-review', expect.objectContaining({ clearDraft: true }))
    expect(screenPrsStore.submittedFor('d8')).toMatchObject({ draftCleared: true })
    // Not emptied locally: main's broadcast of what it kept is what settles it.
    expect(screenPrsStore.draftFor('d8').comments.map((c) => c.text)).toEqual(['while posting'])
    const kept = screenPrsStore.draftFor('d8').comments
    handlers['screenprs:draft-changed']!({ url: 'd8', draft: draft({ comments: kept }), rev: next() })
    await vi.waitFor(() => expect(screenPrsStore.draftFor('d8')).toEqual(draft({ comments: kept })))

    screenPrsStore.resetSubmitted('d8')
    expect(screenPrsStore.submittedFor('d8')).toBeUndefined()
    expect(screenPrsStore.draftFor('d8').comments).toEqual(kept)
    expect(opCalls.map((c) => c.op.kind)).toEqual(['add-comment'])
  })

  it('drops a pending summary that was posted, but keeps one typed after', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(window.api.invoke).mockImplementation(async (channel: string, ...args: unknown[]) => {
        if (channel === 'screenprs:submit-review') return { ok: true, folded: { count: 0, reasons: {} } }
        if (channel === 'screenprs:draft-op') opCalls.push(args[0] as { url: string; op: { kind: string } })
        return undefined
      })
      const pr = (url: string) => ({ owner: 'acme', repo: 'ui', number: 10, url })
      screenPrsStore.setSummary('d10', 'posted text')
      await screenPrsStore.submitReview(pr('d10'), screenPrsStore.draftFor('d10'), { clearDraft: true })

      screenPrsStore.setSummary('d11', 'posted text')
      const posting = screenPrsStore.submitReview(pr('d11'), screenPrsStore.draftFor('d11'), { clearDraft: true })
      screenPrsStore.setSummary('d11', 'a follow-up')
      await posting

      vi.advanceTimersByTime(400)
      expect(opCalls).toEqual([{ url: 'd11', op: { kind: 'set-summary', summary: 'a follow-up' } }])
    } finally {
      vi.useRealTimers()
    }
  })

  it('replays ops a lost connection left unsent, so a reload keeps them', async () => {
    const lost = (name: string): Error => Object.assign(new Error('gone'), { name })
    let failNext: string | null = 'NotSentError'
    const loads: string[] = []
    // Changed on the desktop while the phone was away.
    let stored: PrReviewDraft | null = draft({ verdict: 'comment' })
    vi.mocked(window.api.invoke).mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'screenprs:draft-op') {
        const call = args[0] as { url: string; op: { kind: string } }
        if (failNext) {
          const name = failNext
          failNext = name === 'NotSentError' ? 'ConnectionLostError' : null
          throw lost(name)
        }
        opCalls.push(call)
        stored = applyDraftOp(stored, (call as { op: PrReviewDraftOp }).op)
        return { draft: stored, rev: next() }
      }
      if (channel === 'screenprs:drafts-load') {
        loads.push(opCalls.map((c) => c.op.kind).join(','))
        const drafts: Record<string, PrReviewDraft> = stored ? { d12: stored } : {}
        return { drafts, rev: next() }
      }
      return undefined
    })
    screenPrsStore.addComment('d12', { source: 'you', file: 'a.ts', line: '1', text: 'offline one' })
    const [one] = screenPrsStore.draftFor('d12').comments
    screenPrsStore.updateComment('d12', one.id, { text: 'offline one, edited' })
    expect(failNext).toBeNull()
    await new Promise((r) => setTimeout(r)) // let both failures land
    // Made after the failures: it waits behind them rather than overtaking.
    screenPrsStore.addComment('d12', { source: 'you', file: 'a.ts', line: '2', text: 'offline two' })
    expect(opCalls).toEqual([])

    // The snapshot predates the replayed ops' answers, yet must not drop them.
    await screenPrsStore.loadDrafts()
    expect(loads).toEqual(['add-comment,update-comment,add-comment'])
    await vi.waitFor(() =>
      expect(screenPrsStore.draftFor('d12')).toMatchObject({ verdict: 'comment', comments: [{ text: 'offline one, edited' }, { text: 'offline two' }] })
    )
  })

  it('undoes an op main refused, and says so', async () => {
    handlers['screenprs:draft-changed']!({ url: 'd13', draft: draft({ summary: 'kept' }), rev: next() })
    vi.mocked(window.api.invoke).mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'screenprs:draft-op') {
        opCalls.push(args[0] as { url: string; op: { kind: string } })
        throw new Error('disk full')
      }
      return undefined
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    screenPrsStore.addComment('d13', { source: 'you', file: 'a.ts', line: '1', text: 'refused' })
    await vi.waitFor(() => expect(screenPrsStore.draftFor('d13').comments).toEqual([]))
    expect(screenPrsStore.draftFor('d13').summary).toBe('kept')
    expect(screenPrsStore.draftNoticeFor('d13')).toMatch(/couldn't be saved/)

    // Not retried by a reload.
    await screenPrsStore.loadDrafts()
    expect(opCalls).toHaveLength(1)
    screenPrsStore.dismissDraftNotice('d13')
    expect(screenPrsStore.draftNoticeFor('d13')).toBeUndefined()
  })
})
