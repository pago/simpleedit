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
  ReviewFolds,
} from '../../shared/screenprs'
import { BUCKET_ORDER, compareInBucket, emptyReviewDraft, reviewSubmitError } from '../../shared/screenprs'
import { applyDraftOp, type DraftOpResult, type PrReviewCommentPatch, type PrReviewDraftOp } from '../../shared/review-drafts'
import type { OverviewFacts, OverviewStatus } from '../../shared/pr-overview'

export interface DeepState {
  status: DeepReviewStatus
  lenses: Partial<Record<DeepLensId, DeepLensStatus>>
  findings: DeepFinding[]
  /**
   * The head these findings' line numbers were computed against.
   *
   * Carried because a finding outlives the card it came from — `_deep` survives
   * the `_onQueued` that replaces the queue with bare refs — so a comment
   * lifted from one cannot take its stamp from whatever the live head happens
   * to be at the moment of the tap.
   */
  headSha?: string
  error?: string
}

/** A PR's overview: the raw markdown (parsed on render) and the facts it came with. */
export interface OverviewState {
  status: OverviewStatus
  text?: string
  facts?: OverviewFacts
  /** The head the overview's citations were read off. */
  headSha?: string
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
let _filters = $state<ScreenPrsFilters>({}) // no org scope by default — all orgs where you're a reviewer
let _triaging = $state<Set<string>>(new Set()) // urls the model is actively judging
let _deep = $state<Map<string, DeepState>>(new Map())
let _overview = $state<Map<string, OverviewState>>(new Map())

// ── review composer ──
/** Confirmation that a review was posted to GitHub (keyed by PR url). GitHub
 *  can't retract a submitted review, so this is a terminal, local record — not
 *  an "undo"able draft. */
export interface SubmittedReview {
  verdict: PrReviewVerdict
  reviewUrl?: string
  folded: ReviewFolds
  /** What was posted was the stored draft, which main has cleared. Absent: it stays as typed. */
  draftCleared?: boolean
}
let _submitted = $state<Map<string, SubmittedReview>>(new Map())
let _submitting = $state<Set<string>>(new Set())

// ── draft mirror ──
// Main owns the drafts (main/screenprs-drafts.ts); `_drafts` mirrors them. A
// local change applies here at once and goes to main as an op. Main's answer
// to it, and every other client's change, arrive as revisioned server states.
// While any op for a PR is still unanswered, its server states are held, not
// applied: they predate that op, and applying one would briefly undo it.
let _drafts = $state<Map<string, PrReviewDraft>>(new Map())
const _server = new Map<string, DraftOpResult>()
const _inFlight = new Map<string, number>()
/** PRs whose newest server state has not reached the mirror yet. */
const _held = new Set<string>()
/**
 * Summary text typed on THIS client and not yet sent. It wins over any server
 * state, so another client's change can't rewrite the field mid-sentence.
 */
const _pendingSummary = new Map<string, { text: string; timer: ReturnType<typeof setTimeout> }>()
const SUMMARY_DEBOUNCE_MS = 400
/**
 * Ops a dropped connection never got answered, per PR and in order. They stay
 * applied over every server state until a reconnect resends them.
 */
const _unsent = new Map<string, PrReviewDraftOp[]>()
/** Why a change to a PR's draft was undone, until dismissed. */
let _notices = $state<Map<string, string>>(new Map())

function setMirror(url: string, draft: PrReviewDraft | null): void {
  const next = new Map(_drafts)
  if (draft) next.set(url, draft)
  else next.delete(url)
  _drafts = next
}

function applyServer(url: string): void {
  _held.delete(url)
  let draft = _server.get(url)?.draft ?? null
  for (const op of _unsent.get(url) ?? []) draft = applyDraftOp(draft, op)
  const pending = _pendingSummary.get(url)
  if (pending) draft = applyDraftOp(draft, { kind: 'set-summary', summary: pending.text })
  setMirror(url, draft)
}

function receiveServer(url: string, state: DraftOpResult): void {
  if (state.rev < (_server.get(url)?.rev ?? -Infinity)) return
  _server.set(url, state)
  if (_inFlight.get(url)) _held.add(url)
  else applyServer(url)
}

/**
 * The connection died with the op (the phone's socket), as opposed to main
 * answering it with an error. Matched by name: the error classes live in the
 * web shim, which the desktop build never loads.
 */
function isTransportFailure(err: unknown): boolean {
  return err instanceof Error && (err.name === 'NotSentError' || err.name === 'ConnectionLostError')
}

function setNotice(url: string, notice: string | null): void {
  const next = new Map(_notices)
  if (notice) next.set(url, notice)
  else next.delete(url)
  _notices = next
}

function sendOp(url: string, op: PrReviewDraftOp): void {
  // Behind an op still waiting to be resent, so a replay keeps their order.
  const waiting = _unsent.get(url)
  if (waiting) {
    waiting.push(op)
    return
  }
  _inFlight.set(url, (_inFlight.get(url) ?? 0) + 1)
  window.api
    .invoke('screenprs:draft-op', { url, op })
    .then((res) => receiveServer(url, res))
    .catch((err: unknown) => {
      if (isTransportFailure(err)) {
        // Kept, optimistic change and all, for `loadDrafts` to replay on
        // reconnect. Comment ops are idempotent, so one that did reach main
        // replays as a no-op; a summary or verdict lands again as this
        // client's last word on it.
        _unsent.set(url, [...(_unsent.get(url) ?? []), op])
        return
      }
      console.warn('[screenprs] draft op failed:', err)
      setNotice(url, "A change to this review couldn't be saved, so it was undone.")
      _held.add(url)
    })
    .finally(() => {
      const left = (_inFlight.get(url) ?? 1) - 1
      if (left > 0) {
        _inFlight.set(url, left)
        return
      }
      _inFlight.delete(url)
      if (_held.has(url)) applyServer(url)
    })
}

/** Resend what a lost connection left unsent, in the order it was made. */
function replayUnsent(): void {
  const all = [..._unsent]
  _unsent.clear()
  for (const [url, ops] of all) for (const op of ops) sendOp(url, op)
}

function localOp(url: string, op: PrReviewDraftOp): void {
  const cur = _drafts.get(url) ?? null
  const next = applyDraftOp(cur, op)
  if (next === cur) return
  setMirror(url, next)
  sendOp(url, op)
}

function dropPendingSummary(url: string): void {
  const pending = _pendingSummary.get(url)
  if (!pending) return
  clearTimeout(pending.timer)
  _pendingSummary.delete(url)
}

function setDeep(url: string, patch: Partial<DeepState>): void {
  const next = new Map(_deep)
  const cur = next.get(url) ?? { status: 'idle' as DeepReviewStatus, lenses: {}, findings: [] }
  next.set(url, { ...cur, ...patch })
  _deep = next
}

function setOverview(url: string, patch: Partial<OverviewState>): void {
  const next = new Map(_overview)
  next.set(url, { ...(next.get(url) ?? { status: 'idle' as OverviewStatus }), ...patch })
  _overview = next
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
    setDeep(context.url, { status: 'running', lenses: {}, findings: [], headSha: context.headSha, error: undefined })
    // Snapshot: `context` is a $state proxy from the store — IPC can't clone it.
    await window.api.invoke('screenprs:deep-start', $state.snapshot(context))
  },
  async cancelDeep(url: string): Promise<void> {
    await window.api.invoke('screenprs:deep-cancel', url)
  },

  // ── PR overview ──
  overviewFor(url: string): OverviewState | undefined {
    return _overview.get(url)
  },
  async startOverview(context: PrContext): Promise<void> {
    setOverview(context.url, { status: 'running', text: undefined, facts: undefined, headSha: context.headSha, error: undefined })
    // Snapshot: `context` is a $state proxy from the store — IPC can't clone it.
    await window.api.invoke('screenprs:overview-start', $state.snapshot(context))
  },
  /** Main sends nothing for a cancelled run, so the local state settles here. */
  async cancelOverview(url: string): Promise<void> {
    setOverview(url, { status: 'idle' })
    await window.api.invoke('screenprs:overview-cancel', url)
  },
  _onOverviewResult(url: string, headSha: string, text: string, facts: OverviewFacts): void {
    setOverview(url, { text, facts, headSha })
  },
  _onOverviewStatus(url: string, status: OverviewStatus, error?: string): void {
    setOverview(url, { status, error })
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
  /** Add a comment (deduped on text, file, line and side); its `id` is minted here. */
  addComment(url: string, c: Omit<PrReviewComment, 'id'>): void {
    // Snapshot: `c` can carry $state proxies, and it is about to cross IPC.
    localOp(url, { kind: 'add-comment', comment: { ...$state.snapshot(c), id: crypto.randomUUID() } })
  },
  updateComment(url: string, id: string, patch: PrReviewCommentPatch): void {
    localOp(url, { kind: 'update-comment', id, patch: $state.snapshot(patch) })
  },
  removeComment(url: string, id: string): void {
    localOp(url, { kind: 'remove-comment', id })
  },
  /** The mirror takes the text at once; main gets it once typing pauses. */
  setSummary(url: string, summary: string): void {
    setMirror(url, applyDraftOp(_drafts.get(url) ?? null, { kind: 'set-summary', summary }))
    dropPendingSummary(url)
    const timer = setTimeout(() => {
      _pendingSummary.delete(url)
      sendOp(url, { kind: 'set-summary', summary })
    }, SUMMARY_DEBOUNCE_MS)
    _pendingSummary.set(url, { text: summary, timer })
  },
  setVerdict(url: string, verdict: PrReviewVerdict): void {
    localOp(url, { kind: 'set-verdict', verdict })
  },
  draftNoticeFor(url: string): string | undefined {
    return _notices.get(url)
  },
  dismissDraftNotice(url: string): void {
    setNotice(url, null)
  },
  /**
   * Replace the mirror with main's drafts — at start, and after a reconnect
   * missed broadcasts — with this client's unsent ops replayed over them.
   */
  async loadDrafts(): Promise<void> {
    // Sent first: main answers in order, so the snapshot already holds them.
    replayUnsent()
    try {
      const { drafts, rev } = await window.api.invoke('screenprs:drafts-load')
      const urls = new Set([..._server.keys(), ..._drafts.keys(), ...Object.keys(drafts)])
      for (const url of urls) receiveServer(url, { draft: drafts[url] ?? null, rev })
    } catch (err: unknown) {
      console.warn('[screenprs] loading drafts failed:', err)
    }
  },
  /**
   * Post `draft` to GitHub. `pr` carries the routing fields (owner/repo/number/url).
   * With `headSha`, `draft` is the raw draft and main checks its anchors
   * against that head; without, the caller has run `anchorsForHead` itself.
   * With `clearDraft`, `draft` is the PR's stored draft and goes once posted.
   */
  async submitReview(
    pr: Pick<PrRef, 'owner' | 'repo' | 'number' | 'url'>,
    draft: PrReviewDraft,
    opts?: { headSha?: string; isolatedBase?: boolean; clearDraft?: boolean }
  ): Promise<SubmitReviewResult> {
    const url = pr.url
    _submitting = new Set(_submitting).add(url)
    try {
      const res = await window.api.invoke('screenprs:submit-review', {
        // Plain literals + snapshot — no $state proxy may cross IPC (structured clone throws).
        pr: { owner: pr.owner, repo: pr.repo, number: pr.number, url: pr.url },
        draft: $state.snapshot(draft),
        ...opts,
      })
      if (res.ok) {
        const next = new Map(_submitted)
        next.set(url, { verdict: draft.verdict, reviewUrl: res.reviewUrl, folded: res.folded, draftCleared: opts?.clearDraft })
        _submitted = next
        // The mirror is left for main's post-clear broadcast to settle: it keeps
        // whatever was added while the post was in flight. Only a summary that
        // is exactly what was posted goes, or it would come back as a new one.
        if (opts?.clearDraft && _pendingSummary.get(url)?.text === draft.summary) dropPendingSummary(url)
      }
      return res
    } finally {
      const s = new Set(_submitting)
      s.delete(url)
      _submitting = s
    }
  },
  /** Clear the local "submitted" marker so a follow-up review can be composed.
   *  The draft is not touched: a post that took it has already had main clear
   *  it, and anything added since is the follow-up's.
   *  Does NOT retract the posted review — GitHub has no such API. */
  resetSubmitted(url: string): void {
    const next = new Map(_submitted)
    next.delete(url)
    _submitted = next
  },
  _onDraftChanged(url: string, state: DraftOpResult): void {
    receiveServer(url, state)
  },
  _onDeepLens(url: string, lens: DeepLensId, status: DeepLensStatus): void {
    const cur = _deep.get(url)
    setDeep(url, { lenses: { ...(cur?.lenses ?? {}), [lens]: status } })
  },
  _onDeepResult(url: string, findings: DeepFinding[], headSha: string): void {
    setDeep(url, { findings, headSha })
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

/** Subscribe to the `screenprs:*` stream and load the drafts. Call once at app start; returns an unsub. */
export function initScreenPrsListeners(): () => void {
  const unsubQueued = window.api.on('screenprs:queued', (d) => screenPrsStore._onQueued(d.refs))
  const unsubScreening = window.api.on('screenprs:screening', (d) => screenPrsStore._onScreening(d.context))
  const unsubTriaging = window.api.on('screenprs:triaging', (d) => screenPrsStore._onTriaging(d.url))
  const unsubCard = window.api.on('screenprs:card', (d) => screenPrsStore._onCard(d.card))
  const unsubStatus = window.api.on('screenprs:status', (d) => screenPrsStore._onStatus(d.status, d.total, d.error))
  const unsubDeepLens = window.api.on('screenprs:deep-lens', (d) => screenPrsStore._onDeepLens(d.url, d.lens, d.status))
  const unsubDeepResult = window.api.on('screenprs:deep-result', (d) => screenPrsStore._onDeepResult(d.url, d.findings, d.headSha))
  const unsubDeepStatus = window.api.on('screenprs:deep-status', (d) => screenPrsStore._onDeepStatus(d.url, d.status, d.error))
  const unsubOverviewResult = window.api.on('screenprs:overview-result', (d) =>
    screenPrsStore._onOverviewResult(d.url, d.headSha, d.text, d.facts)
  )
  const unsubOverviewStatus = window.api.on('screenprs:overview-status', (d) =>
    screenPrsStore._onOverviewStatus(d.url, d.status, d.error)
  )
  const unsubDraftChanged = window.api.on('screenprs:draft-changed', (d) =>
    screenPrsStore._onDraftChanged(d.url, { draft: d.draft, rev: d.rev })
  )
  void screenPrsStore.loadDrafts()
  return () => {
    unsubQueued()
    unsubScreening()
    unsubTriaging()
    unsubCard()
    unsubStatus()
    unsubDeepLens()
    unsubDeepResult()
    unsubDeepStatus()
    unsubOverviewResult()
    unsubOverviewStatus()
    unsubDraftChanged()
  }
}
