import { describe, it, expect, beforeEach, vi } from 'vitest'
import { screenPrsStore, initScreenPrsListeners } from '../screenprs.svelte'
import type { EventMap } from '../../../shared/ipc-types'
import { bucketOf, type ScreenPrCard, type PrContext } from '../../../shared/screenprs'

type Handlers = {
  'screenprs:screening'?: (d: EventMap['screenprs:screening']) => void
  'screenprs:card'?: (d: EventMap['screenprs:card']) => void
  'screenprs:status'?: (d: EventMap['screenprs:status']) => void
  'screenprs:deep-lens'?: (d: EventMap['screenprs:deep-lens']) => void
  'screenprs:deep-result'?: (d: EventMap['screenprs:deep-result']) => void
  'screenprs:deep-status'?: (d: EventMap['screenprs:deep-status']) => void
}

let handlers: Handlers
let dispose: () => void

function ctx(over: Partial<PrContext> & { number: number; url: string }): PrContext {
  return {
    owner: 'ivx', repo: 'ui', title: 't', author: 'a', updatedAt: '2026-07-01',
    headSha: 'sha1', additions: 10, deletions: 1, changedFiles: 1, baseRefName: 'main',
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
    })
    handlers['screenprs:deep-status']!({ url: 'u1', status: 'done' })

    const d = screenPrsStore.deepFor('u1')
    expect(d?.status).toBe('done')
    expect(d?.lenses.soundness).toBe('done')
    expect(d?.findings).toHaveLength(1)
    // A different PR is unaffected.
    expect(screenPrsStore.deepFor('other')).toBeUndefined()
  })

  it('unsubscribes cleanly', () => {
    dispose()
    expect(handlers['screenprs:card']).toBeUndefined()
    expect(handlers['screenprs:deep-status']).toBeUndefined()
  })
})
