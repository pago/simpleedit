import { vi } from 'vitest'
import type { Review, ReviewMessage, ReviewOp, ReviewThread } from '../../../../shared/review-room'
import type { ReviewLayerInfo } from '../../../../shared/review-room-ipc'
import type { PrReviewDraft } from '../../../../shared/screenprs'
import { applyDraftOp, type PrReviewDraftOp } from '../../../../shared/review-drafts'

export const REVIEW_ID = 'r_review01'
export const URL_1 = 'https://github.com/acme/app/pull/183'
export const URL_2 = 'https://github.com/acme/app/pull/184'

export function layer(n: number, url: string, over: Partial<ReviewLayerInfo> = {}): ReviewLayerInfo {
  return {
    url,
    owner: 'acme',
    repo: 'app',
    number: n,
    title: `Layer ${n}`,
    author: 'dana',
    isDraft: false,
    state: 'OPEN',
    baseRefName: 'main',
    headRefName: `b${n}`,
    headSha: `sha${n}`,
    additions: 3,
    deletions: 1,
    changedFiles: 1,
    ci: 'green',
    body: '',
    ...over,
  }
}

export function review(over: Partial<Review> = {}): Review {
  return {
    id: REVIEW_ID,
    repo: 'acme/app',
    layers: [
      { url: URL_1, number: 183, headSha: 'sha183' },
      { url: URL_2, number: 184, headSha: 'sha184' },
    ],
    status: 'open',
    companionAgent: { provider: 'claude', model: '' },
    lastSeenHead: {},
    readSteps: [],
    round: 1,
    submissions: [],
    createdAt: '2026-10-16T00:00:00Z',
    updatedAt: '2026-10-16T00:00:00Z',
    ...over,
  }
}

let seq = 0
// Never reset: the stores are module singletons and ignore revisions older than one they have seen.
let rev = 10_000
export function msg(author: ReviewMessage['author'], body: string, over: Partial<ReviewMessage> = {}): ReviewMessage {
  seq++
  return { id: `rm_msg${String(seq).padStart(6, '0')}`, seq, author, body, at: '2026-10-16T00:00:00Z', ...over }
}

export function thread(over: Partial<ReviewThread> = {}): ReviewThread {
  return {
    id: 'rt_thread01',
    reviewId: REVIEW_ID,
    anchor: { kind: 'line', pr: 183, headSha: 'sha183', path: 'src/a.ts', side: 'RIGHT', startLine: 2, endLine: 2, snippet: 'const b = 2', before: '', after: '' },
    origin: { kind: 'finding', source: 'deep', key: 'k1', severity: 'consider', lens: 'soundness', preExisting: false },
    status: 'open',
    outdated: false,
    readSeq: 0,
    askAuthorOpen: false,
    messages: [msg('tool', 'The retry loop never backs off')],
    createdAt: '2026-10-16T00:00:00Z',
    updatedAt: '2026-10-16T00:00:00Z',
    ...over,
  }
}

/**
 * A `window.api` that keeps drafts like main does and records review ops.
 * `extra` answers any other channel.
 */
export function stubApi(extra: (channel: string, ...args: unknown[]) => unknown = () => undefined): {
  invoke: ReturnType<typeof vi.fn>
  ops: Array<{ reviewId: string; op: ReviewOp | { kind: string } }>
  emit: (channel: string, payload: unknown) => void
} {
  const drafts = new Map<string, PrReviewDraft>()
  const ops: Array<{ reviewId: string; op: ReviewOp | { kind: string } }> = []
  const listeners = new Map<string, Array<(payload: unknown) => void>>()
  const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === 'screenprs:drafts-load') return { drafts: Object.fromEntries(drafts), rev: ++rev }
    if (channel === 'screenprs:draft-op') {
      const { url, op } = args[0] as { url: string; op: PrReviewDraftOp }
      const next = applyDraftOp(drafts.get(url) ?? null, op)
      if (next) drafts.set(url, next)
      else drafts.delete(url)
      return { draft: next, rev: ++rev }
    }
    if (channel === 'review:op') {
      ops.push(args[0] as { reviewId: string; op: ReviewOp })
      return null
    }
    if (channel === 'models:config-get') return { defaults: {}, submenuAllowlist: [] }
    if (channel === 'models:claude' || channel === 'models:codex' || channel === 'models:opencode' || channel === 'models:installed') return []
    return extra(channel, ...args)
  })
  const on = (channel: string, handler: (payload: unknown) => void): (() => void) => {
    listeners.set(channel, [...(listeners.get(channel) ?? []), handler])
    return () => listeners.set(channel, (listeners.get(channel) ?? []).filter((h) => h !== handler))
  }
  vi.stubGlobal('api', { invoke, on, once: vi.fn() })
  return { invoke, ops, emit: (channel, payload) => (listeners.get(channel) ?? []).forEach((h) => h(payload)) }
}
