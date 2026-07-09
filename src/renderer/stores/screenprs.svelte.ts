/**
 * Screen PRs renderer state. Listens to the `screenprs:*` stream, holds one
 * entry per PR (a context placeholder that upgrades to a full card once triage
 * lands), and derives the bucketed, sorted queue. Bucketing/sorting is the
 * shared pure logic (screenprs.ts), so this store never re-implements the rules.
 */
import type { ScreenPrsFilters, ScreenPrsRunStatus, SubmitReviewResult } from '../../shared/ipc-types'
import type {
  PrRef,
  PrContext,
  ScreenPrCard,
  ScreenPrBucket,
  DeepFinding,
  DeepLensId,
  DeepReviewStatus,
  DeepLensStatus,
  PrReviewDraft,
  PrReviewComment,
  PrReviewVerdict,
} from '../../shared/screenprs'
import { BUCKET_ORDER, compareInBucket, emptyReviewDraft, reviewSubmitError } from '../../shared/screenprs'

export interface DeepState {
  status: DeepReviewStatus
  lenses: Partial<Record<DeepLensId, DeepLensStatus>>
  findings: DeepFinding[]
  error?: string
}

export type ScreenStatus = 'idle' | ScreenPrsRunStatus

/** A queue slot: always a `ref`; gains `context` when gathered, `card` when triaged. */
export interface Entry {
  ref: PrRef
  context?: PrContext
  card?: ScreenPrCard
}

/** A still-screening PR's phase: gathering its diff, queued for the model, or
 *  actively being judged right now. */
export type TriagePhase = 'gathering' | 'scheduled' | 'running'

/** What the "Screening…" section renders: the ref, context once available, phase. */
export interface PendingEntry {
  ref: PrRef
  context?: PrContext
  phase: TriagePhase
}

const keyOf = (pr: { url: string }): string => pr.url

let _entries = $state<Map<string, Entry>>(new Map())
let _status = $state<ScreenStatus>('idle')
let _error = $state<string | undefined>(undefined)
let _total = $state<number | undefined>(undefined)
let _selected = $state<string | null>(null)
let _filters = $state<ScreenPrsFilters>({ owner: 'ivx' })
let _triaging = $state<Set<string>>(new Set()) // urls the model is actively judging
let _deep = $state<Map<string, DeepState>>(new Map())

// ── review composer ──
/** Confirmation that a review was posted to GitHub (keyed by PR url). GitHub
 *  can't retract a submitted review, so this is a terminal, local record — not
 *  an "undo"able draft. */
export interface SubmittedReview {
  verdict: PrReviewVerdict
  reviewUrl?: string
  foldedComments: boolean
}
let _drafts = $state<Map<string, PrReviewDraft>>(new Map())
let _submitted = $state<Map<string, SubmittedReview>>(new Map())
let _submitting = $state<Set<string>>(new Set())

function setDraft(url: string, patch: Partial<PrReviewDraft>): void {
  const next = new Map(_drafts)
  next.set(url, { ...(next.get(url) ?? emptyReviewDraft()), ...patch })
  _drafts = next
}

function setDeep(url: string, patch: Partial<DeepState>): void {
  const next = new Map(_deep)
  const cur = next.get(url) ?? { status: 'idle' as DeepReviewStatus, lenses: {}, findings: [] }
  next.set(url, { ...cur, ...patch })
  _deep = next
}

function setEntry(key: string, patch: Partial<Entry>): void {
  const next = new Map(_entries)
  const cur = next.get(key)
  const ref = patch.ref ?? cur?.ref ?? patch.context ?? patch.card
  if (!ref) return
  next.set(key, { ref, context: patch.context ?? cur?.context, card: patch.card ?? cur?.card })
  _entries = next
}

export const screenPrsStore = {
  status: (): ScreenStatus => _status,
  error: (): string | undefined => _error,
  total: (): number | undefined => _total,
  filters: (): ScreenPrsFilters => _filters,
  selectedKey: (): string | null => _selected,

  entries: (): Entry[] => [..._entries.values()],
  /** PRs still being screened (no final card yet), tagged with their phase. */
  pending: (): PendingEntry[] =>
    [..._entries.values()]
      .filter((e) => !e.card)
      .map((e) => ({
        ref: e.ref,
        context: e.context,
        phase: _triaging.has(e.ref.url) ? 'running' : e.context ? 'scheduled' : 'gathering',
      })),

  /** Completed cards grouped by bucket, each group sorted worst/most-relevant first. */
  byBucket(): Record<ScreenPrBucket, ScreenPrCard[]> {
    const out = { attention: [], quick: [], waiting: [], fyi: [] } as Record<ScreenPrBucket, ScreenPrCard[]>
    for (const e of _entries.values()) if (e.card) out[e.card.bucket].push(e.card)
    for (const b of BUCKET_ORDER) out[b].sort(compareInBucket)
    return out
  },

  attentionCount: (): number => [..._entries.values()].filter((e) => e.card?.bucket === 'attention').length,

  selectedCard(): ScreenPrCard | undefined {
    return _selected ? _entries.get(_selected)?.card : undefined
  },
  selectedContext(): PrContext | undefined {
    return _selected ? _entries.get(_selected)?.context : undefined
  },

  select(key: string | null): void {
    _selected = key
  },

  setFilters(f: ScreenPrsFilters): void {
    _filters = f
  },

  async start(filters?: ScreenPrsFilters): Promise<void> {
    if (filters) _filters = filters
    _entries = new Map()
    _triaging = new Set()
    _selected = null
    _error = undefined
    _total = undefined
    _status = 'running'
    // $state.snapshot: strip the reactive proxy — Electron IPC structured-clone
    // can't serialize a Svelte proxy ("An object could not be cloned").
    await window.api.invoke('screenprs:start', $state.snapshot(_filters))
  },

  async cancel(): Promise<void> {
    await window.api.invoke('screenprs:cancel')
  },

  // ── deep review ──
  deepFor(url: string): DeepState | undefined {
    return _deep.get(url)
  },
  async startDeep(context: PrContext): Promise<void> {
    setDeep(context.url, { status: 'running', lenses: {}, findings: [], error: undefined })
    // Snapshot: `context` is a $state proxy from the store — IPC can't clone it.
    await window.api.invoke('screenprs:deep-start', $state.snapshot(context))
  },
  async cancelDeep(url: string): Promise<void> {
    await window.api.invoke('screenprs:deep-cancel', url)
  },

  // ── review composer (the GitHub write path) ──
  draftFor(url: string): PrReviewDraft {
    return _drafts.get(url) ?? emptyReviewDraft()
  },
  submittedFor(url: string): SubmittedReview | undefined {
    return _submitted.get(url)
  },
  isSubmitting(url: string): boolean {
    return _submitting.has(url)
  },
  /** Why the current draft can't be posted, or null — mirrors the main-process guard. */
  draftError(url: string): string | null {
    return reviewSubmitError(_drafts.get(url) ?? emptyReviewDraft())
  },
  addComment(url: string, c: PrReviewComment): void {
    const cur = _drafts.get(url) ?? emptyReviewDraft()
    // Dedupe: the same finding shouldn't stack up if ＋review is clicked twice.
    if (cur.comments.some((x) => x.text === c.text && x.file === c.file && x.line === c.line)) return
    setDraft(url, { comments: [...cur.comments, c] })
  },
  removeComment(url: string, index: number): void {
    const cur = _drafts.get(url)
    if (!cur) return
    setDraft(url, { comments: cur.comments.filter((_, i) => i !== index) })
  },
  setSummary(url: string, summary: string): void {
    setDraft(url, { summary })
  },
  setVerdict(url: string, verdict: PrReviewVerdict): void {
    setDraft(url, { verdict })
  },
  /** Post `draft` to GitHub. `pr` carries the routing fields (owner/repo/number/url). */
  async submitReview(
    pr: Pick<PrRef, 'owner' | 'repo' | 'number' | 'url'>,
    draft: PrReviewDraft
  ): Promise<SubmitReviewResult> {
    const url = pr.url
    _submitting = new Set(_submitting).add(url)
    try {
      const res = await window.api.invoke('screenprs:submit-review', {
        // Plain literals + snapshot — no $state proxy may cross IPC (structured clone throws).
        pr: { owner: pr.owner, repo: pr.repo, number: pr.number, url: pr.url },
        draft: $state.snapshot(draft),
      })
      if (res.ok) {
        const next = new Map(_submitted)
        next.set(url, { verdict: draft.verdict, reviewUrl: res.reviewUrl, foldedComments: res.foldedComments })
        _submitted = next
      }
      return res
    } finally {
      const s = new Set(_submitting)
      s.delete(url)
      _submitting = s
    }
  },
  /** Clear the local "submitted" marker so a follow-up review can be composed.
   *  Does NOT retract the posted review — GitHub has no such API. */
  resetSubmitted(url: string): void {
    const next = new Map(_submitted)
    next.delete(url)
    _submitted = next
    setDraft(url, emptyReviewDraft())
  },
  _onDeepLens(url: string, lens: DeepLensId, status: DeepLensStatus): void {
    const cur = _deep.get(url)
    setDeep(url, { lenses: { ...(cur?.lenses ?? {}), [lens]: status } })
  },
  _onDeepResult(url: string, findings: DeepFinding[]): void {
    setDeep(url, { findings })
  },
  _onDeepStatus(url: string, status: DeepReviewStatus, error?: string): void {
    setDeep(url, { status, error })
  },

  // ── event ingestion (wired by initScreenPrsListeners) ──
  _onQueued(refs: PrRef[]): void {
    const next = new Map<string, Entry>()
    for (const ref of refs) next.set(keyOf(ref), { ref })
    _entries = next
    _total = refs.length
    _triaging = new Set()
  },
  _onScreening(context: PrContext): void {
    setEntry(keyOf(context), { context })
  },
  _onTriaging(url: string): void {
    const next = new Set(_triaging)
    next.add(url)
    _triaging = next
  },
  _onCard(card: ScreenPrCard): void {
    // A card IS a full context (+bucket), so set both — a cached PR emits a card
    // with no prior `screening` event and still needs its context for the detail.
    setEntry(keyOf(card), { context: card, card })
    if (_triaging.has(card.url)) {
      const next = new Set(_triaging)
      next.delete(card.url)
      _triaging = next
    }
  },
  _onStatus(status: ScreenPrsRunStatus, total?: number, error?: string): void {
    _status = status
    if (total !== undefined) _total = total
    _error = error
  },
}

/** Subscribe to the `screenprs:*` stream. Call once at app start; returns an unsub. */
export function initScreenPrsListeners(): () => void {
  const unsubQueued = window.api.on('screenprs:queued', (d) => screenPrsStore._onQueued(d.refs))
  const unsubScreening = window.api.on('screenprs:screening', (d) => screenPrsStore._onScreening(d.context))
  const unsubTriaging = window.api.on('screenprs:triaging', (d) => screenPrsStore._onTriaging(d.url))
  const unsubCard = window.api.on('screenprs:card', (d) => screenPrsStore._onCard(d.card))
  const unsubStatus = window.api.on('screenprs:status', (d) => screenPrsStore._onStatus(d.status, d.total, d.error))
  const unsubDeepLens = window.api.on('screenprs:deep-lens', (d) => screenPrsStore._onDeepLens(d.url, d.lens, d.status))
  const unsubDeepResult = window.api.on('screenprs:deep-result', (d) => screenPrsStore._onDeepResult(d.url, d.findings))
  const unsubDeepStatus = window.api.on('screenprs:deep-status', (d) => screenPrsStore._onDeepStatus(d.url, d.status, d.error))
  return () => {
    unsubQueued()
    unsubScreening()
    unsubTriaging()
    unsubCard()
    unsubStatus()
    unsubDeepLens()
    unsubDeepResult()
    unsubDeepStatus()
  }
}
