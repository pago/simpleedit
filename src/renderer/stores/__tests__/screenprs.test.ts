import { describe, it, expect, beforeEach, vi } from 'vitest'
import { screenPrsStore, initScreenPrsListeners } from '../screenprs.svelte'
import type { EventMap } from '../../../shared/ipc-types'
import { bucketOf, type ScreenPrCard, type PrContext } from '../../../shared/screenprs'

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
    invoke: vi.fn().mockResolvedValue(undefined),
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
