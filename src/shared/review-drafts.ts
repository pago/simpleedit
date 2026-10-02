/**
 * Review drafts as a sequence of ops. Main owns the persisted drafts
 * (main/screenprs-drafts.ts) and every client mirrors them, so a change is
 * sent as the smallest op that expresses it rather than as a whole draft: two
 * clients editing different parts of one draft then cannot overwrite each
 * other. Both sides apply ops through `applyDraftOp`, so the optimistic mirror
 * and main agree on dedupe and on when a draft stops existing.
 */
import { emptyReviewDraft, isPrUrl, type PrReviewComment, type PrReviewCommentSource, type PrReviewDraft, type PrReviewVerdict } from './screenprs'

export type PrReviewCommentPatch = Partial<Omit<PrReviewComment, 'id'>>

export type PrReviewDraftOp =
  | { kind: 'add-comment'; comment: PrReviewComment }
  | { kind: 'update-comment'; id: string; patch: PrReviewCommentPatch }
  | { kind: 'remove-comment'; id: string }
  | { kind: 'set-summary'; summary: string }
  | { kind: 'set-verdict'; verdict: PrReviewVerdict }
  | { kind: 'clear' }
  /**
   * What a successful post makes redundant, and nothing else: a comment added,
   * or a summary or verdict changed, while the post was in flight survives.
   */
  | { kind: 'clear-posted'; ids: string[]; summary: string; verdict: PrReviewVerdict }

/** Every draft main holds, and the revision they stand at. */
export interface DraftsSnapshot {
  drafts: Record<string, PrReviewDraft>
  rev: number
}

/** One PR's draft after an op (null: it no longer exists), and its revision. */
export interface DraftOpResult {
  draft: PrReviewDraft | null
  rev: number
}

/**
 * Indistinguishable from a draft nobody started. The verdict counts: picking
 * one before writing anything is still a choice, and deleting that draft
 * would hand the default verdict back to the client that just changed it.
 */
export function isEmptyDraft(draft: PrReviewDraft): boolean {
  const empty = emptyReviewDraft()
  return draft.comments.length === 0 && draft.summary === empty.summary && draft.verdict === empty.verdict
}

/** The op that clears `posted` — the draft as submitted — out of the stored one. */
export function clearPostedOp(posted: PrReviewDraft): PrReviewDraftOp {
  return { kind: 'clear-posted', ids: posted.comments.map((c) => c.id), summary: posted.summary, verdict: posted.verdict }
}

/** The same finding shouldn't stack up if ＋review is clicked twice. */
function isDuplicate(a: Omit<PrReviewComment, 'id'>, b: Omit<PrReviewComment, 'id'>): boolean {
  return a.text === b.text && a.file === b.file && a.line === b.line && (a.side ?? 'RIGHT') === (b.side ?? 'RIGHT')
}

/**
 * `op` applied to `draft` (null: no draft yet). Returns null when the result
 * is empty, because an empty draft is not stored, and returns `draft` itself
 * when the op changes nothing, so a caller can skip a write by identity.
 */
export function applyDraftOp(draft: PrReviewDraft | null, op: PrReviewDraftOp): PrReviewDraft | null {
  const cur = draft ?? emptyReviewDraft()
  let next: PrReviewDraft
  switch (op.kind) {
    case 'add-comment':
      if (cur.comments.some((c) => c.id === op.comment.id || isDuplicate(c, op.comment))) return draft
      next = { ...cur, comments: [...cur.comments, op.comment] }
      break
    case 'update-comment': {
      const target = cur.comments.find((c) => c.id === op.id)
      if (!target) return draft
      const updated = { ...target, ...op.patch, id: target.id }
      if (cur.comments.some((c) => c.id !== op.id && isDuplicate(c, updated))) return draft
      next = { ...cur, comments: cur.comments.map((c) => (c.id === op.id ? updated : c)) }
      break
    }
    case 'remove-comment':
      if (!cur.comments.some((c) => c.id === op.id)) return draft
      next = { ...cur, comments: cur.comments.filter((c) => c.id !== op.id) }
      break
    case 'set-summary':
      if (cur.summary === op.summary) return draft
      next = { ...cur, summary: op.summary }
      break
    case 'set-verdict':
      if (cur.verdict === op.verdict) return draft
      next = { ...cur, verdict: op.verdict }
      break
    case 'clear':
      return null
    case 'clear-posted': {
      const empty = emptyReviewDraft()
      const posted = new Set(op.ids)
      const comments = cur.comments.filter((c) => !posted.has(c.id))
      const summary = cur.summary === op.summary ? empty.summary : cur.summary
      const verdict = cur.verdict === op.verdict ? empty.verdict : cur.verdict
      if (comments.length === cur.comments.length && summary === cur.summary && verdict === cur.verdict) return draft
      next = { comments, summary, verdict }
      break
    }
  }
  return isEmptyDraft(next) ? null : next
}

// ── Validation ──────────────────────────────────────────────────────────────
// Ops arrive from the phone over a socket and are written to disk as-is, and
// every client renders what is on disk, so main checks each one before it is
// applied. The same checks clean a drafts file on load.

const MAX_URL = 512
const MAX_TEXT = 64 * 1024
const MAX_FIELD = 1024
const MAX_IDS = 1000

const SOURCES: readonly PrReviewCommentSource[] = ['triage', 'deep', 'overview', 'agent', 'you']
const VERDICTS: readonly PrReviewVerdict[] = ['approve', 'comment', 'request_changes']

type Fields = Record<string, unknown>

function isObject(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max
}

function isVerdict(value: unknown): value is PrReviewVerdict {
  return VERDICTS.includes(value as PrReviewVerdict)
}

/**
 * The comment fields present in `value`, each checked, or null if any is
 * malformed. Unknown keys are left behind rather than stored.
 */
function commentFields(value: Fields): PrReviewCommentPatch | null {
  const out: PrReviewCommentPatch = {}
  if ('source' in value) {
    if (!SOURCES.includes(value.source as PrReviewCommentSource)) return null
    out.source = value.source as PrReviewCommentSource
  }
  if ('file' in value) {
    if (!isString(value.file, MAX_FIELD)) return null
    out.file = value.file
  }
  if ('line' in value) {
    if (!isString(value.line, MAX_FIELD)) return null
    out.line = value.line
  }
  if ('side' in value) {
    if (value.side !== 'LEFT' && value.side !== 'RIGHT') return null
    out.side = value.side
  }
  if ('text' in value) {
    if (!isString(value.text, MAX_TEXT)) return null
    out.text = value.text
  }
  if ('snippet' in value) {
    if (!isString(value.snippet, MAX_TEXT)) return null
    out.snippet = value.snippet
  }
  if ('sha' in value) {
    if (!isString(value.sha, MAX_FIELD)) return null
    // Stored, '' would claim a head the comment doesn't belong to (see `sha`).
    if (value.sha) out.sha = value.sha
  }
  return out
}

/** `value` as a review comment, or null if it isn't a well-formed one. */
export function parseReviewComment(value: unknown): PrReviewComment | null {
  if (!isObject(value) || !isString(value.id, MAX_FIELD) || !value.id) return null
  const fields = commentFields(value)
  if (!fields || fields.source === undefined || fields.file === undefined || fields.text === undefined) return null
  return { ...fields, id: value.id, source: fields.source, file: fields.file, text: fields.text }
}

/**
 * A stored draft with every malformed part dropped: a bad comment goes, a bad
 * summary or verdict falls back to the empty draft's. Null if nothing is left.
 */
export function parseReviewDraft(value: unknown): PrReviewDraft | null {
  if (!isObject(value)) return null
  const empty = emptyReviewDraft()
  const comments = Array.isArray(value.comments)
    ? value.comments.map(parseReviewComment).filter((c): c is PrReviewComment => c !== null)
    : []
  const draft: PrReviewDraft = {
    comments,
    summary: isString(value.summary, MAX_TEXT) ? value.summary : empty.summary,
    verdict: isVerdict(value.verdict) ? value.verdict : empty.verdict,
  }
  return isEmptyDraft(draft) ? null : draft
}

function parseOp(op: unknown): PrReviewDraftOp | null {
  if (!isObject(op)) return null
  switch (op.kind) {
    case 'add-comment': {
      const comment = parseReviewComment(op.comment)
      return comment && { kind: op.kind, comment }
    }
    case 'update-comment': {
      if (!isString(op.id, MAX_FIELD) || !isObject(op.patch)) return null
      const patch = commentFields(op.patch)
      return patch && { kind: op.kind, id: op.id, patch }
    }
    case 'remove-comment':
      return isString(op.id, MAX_FIELD) ? { kind: op.kind, id: op.id } : null
    case 'set-summary':
      return isString(op.summary, MAX_TEXT) ? { kind: op.kind, summary: op.summary } : null
    case 'set-verdict':
      return isVerdict(op.verdict) ? { kind: op.kind, verdict: op.verdict } : null
    case 'clear':
      return { kind: op.kind }
    case 'clear-posted': {
      const { ids } = op
      if (!Array.isArray(ids) || ids.length > MAX_IDS || !ids.every((id) => isString(id, MAX_FIELD))) return null
      if (!isString(op.summary, MAX_TEXT) || !isVerdict(op.verdict)) return null
      return { kind: op.kind, ids, summary: op.summary, verdict: op.verdict }
    }
    default:
      return null
  }
}

/**
 * A `screenprs:draft-op` request, checked field by field and rebuilt from
 * only the fields it knows. Throws on anything malformed, so nothing is
 * written.
 */
export function parseDraftOpRequest(request: unknown): { url: string; op: PrReviewDraftOp } {
  if (!isObject(request)) throw new Error('Malformed draft op request')
  const { url } = request
  if (!isString(url, MAX_URL) || !isPrUrl(url)) throw new Error('Draft op for something that is not a pull-request URL')
  const op = parseOp(request.op)
  if (!op) throw new Error('Malformed draft op')
  return { url, op }
}
