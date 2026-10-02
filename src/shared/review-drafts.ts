/**
 * Review drafts as a sequence of ops. Main owns the persisted drafts
 * (main/screenprs-drafts.ts) and every client mirrors them, so a change is
 * sent as the smallest op that expresses it rather than as a whole draft: two
 * clients editing different parts of one draft then cannot overwrite each
 * other. Both sides apply ops through `applyDraftOp`, so the optimistic mirror
 * and main agree on dedupe and on when a draft stops existing.
 */
import { emptyReviewDraft, type PrReviewComment, type PrReviewDraft, type PrReviewVerdict } from './screenprs'

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
