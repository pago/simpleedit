/**
 * Screen PRs renderer state. Listens to the `screenprs:*` stream, holds one
 * entry per PR (a context placeholder that upgrades to a full card once triage
 * lands), and derives the bucketed, sorted queue. Bucketing/sorting is the
 * shared pure logic (screenprs.ts), so this store never re-implements the rules.
 */
import type { ScreenPrsFilters, ScreenPrsRunStatus } from '../../shared/ipc-types'
import type {
  PrContext,
  ScreenPrCard,
  ScreenPrBucket,
  DeepFinding,
  DeepLensId,
  DeepReviewStatus,
  DeepLensStatus,
} from '../../shared/screenprs'
import { BUCKET_ORDER, compareInBucket } from '../../shared/screenprs'

export interface DeepState {
  status: DeepReviewStatus
  lenses: Partial<Record<DeepLensId, DeepLensStatus>>
  findings: DeepFinding[]
  error?: string
}

export type ScreenStatus = 'idle' | ScreenPrsRunStatus

interface Entry {
  context: PrContext
  card?: ScreenPrCard
}

const keyOf = (pr: { url: string }): string => pr.url

let _entries = $state<Map<string, Entry>>(new Map())
let _status = $state<ScreenStatus>('idle')
let _error = $state<string | undefined>(undefined)
let _total = $state<number | undefined>(undefined)
let _selected = $state<string | null>(null)
let _filters = $state<ScreenPrsFilters>({ owner: 'ivx' })
let _deep = $state<Map<string, DeepState>>(new Map())

function setDeep(url: string, patch: Partial<DeepState>): void {
  const next = new Map(_deep)
  const cur = next.get(url) ?? { status: 'idle' as DeepReviewStatus, lenses: {}, findings: [] }
  next.set(url, { ...cur, ...patch })
  _deep = next
}

function setEntry(key: string, patch: Partial<Entry> & { context: PrContext }): void {
  const next = new Map(_entries)
  next.set(key, { ...next.get(key), ...patch })
  _entries = next
}

export const screenPrsStore = {
  status: (): ScreenStatus => _status,
  error: (): string | undefined => _error,
  total: (): number | undefined => _total,
  filters: (): ScreenPrsFilters => _filters,
  selectedKey: (): string | null => _selected,

  entries: (): Entry[] => [..._entries.values()],
  /** PRs whose context arrived but triage hasn't finished yet. */
  pending: (): PrContext[] => [..._entries.values()].filter((e) => !e.card).map((e) => e.context),

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
    _selected = null
    _error = undefined
    _total = undefined
    _status = 'running'
    await window.api.invoke('screenprs:start', _filters)
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
    await window.api.invoke('screenprs:deep-start', context)
  },
  async cancelDeep(url: string): Promise<void> {
    await window.api.invoke('screenprs:deep-cancel', url)
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
  _onScreening(context: PrContext): void {
    setEntry(keyOf(context), { context })
  },
  _onCard(card: ScreenPrCard): void {
    setEntry(keyOf(card), { context: card, card })
  },
  _onStatus(status: ScreenPrsRunStatus, total?: number, error?: string): void {
    _status = status
    if (total !== undefined) _total = total
    _error = error
  },
}

/** Subscribe to the `screenprs:*` stream. Call once at app start; returns an unsub. */
export function initScreenPrsListeners(): () => void {
  const unsubScreening = window.api.on('screenprs:screening', (d) => screenPrsStore._onScreening(d.context))
  const unsubCard = window.api.on('screenprs:card', (d) => screenPrsStore._onCard(d.card))
  const unsubStatus = window.api.on('screenprs:status', (d) => screenPrsStore._onStatus(d.status, d.total, d.error))
  const unsubDeepLens = window.api.on('screenprs:deep-lens', (d) => screenPrsStore._onDeepLens(d.url, d.lens, d.status))
  const unsubDeepResult = window.api.on('screenprs:deep-result', (d) => screenPrsStore._onDeepResult(d.url, d.findings))
  const unsubDeepStatus = window.api.on('screenprs:deep-status', (d) => screenPrsStore._onDeepStatus(d.url, d.status, d.error))
  return () => {
    unsubScreening()
    unsubCard()
    unsubStatus()
    unsubDeepLens()
    unsubDeepResult()
    unsubDeepStatus()
  }
}
