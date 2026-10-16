/**
 * The pure half of Review Room posting (`main/github/review-graphql.ts`): which
 * draft comments go on a line, which reply to an existing thread and which fold
 * into the review body, and the bodies each is sent with.
 */
import {
  anchorsForHead,
  foldedReviewPayload,
  resolveAnchor,
  reviewFolds,
  type PrReviewComment,
  type PrReviewDraft,
  type ReviewFolds,
  type ReviewPayloadOptions,
} from './screenprs'
import type { ReviewSeverity } from './review-room'

/** Conventional-comment labels, so the severity survives on GitHub. */
export const SEVERITY_PREFIX: Record<ReviewSeverity, string> = {
  blocking: '**blocking:** ',
  consider: '**consider:** ',
  nit: '**nit:** ',
}

const ITEM_MARKER = /<!-- se:([A-Za-z0-9_-]{1,80}) -->/
const CLAIM_MARKER = /\n*<!-- se-review:[A-Za-z0-9_-]{1,80} -->/g

export function withSeverity(c: Pick<PrReviewComment, 'text' | 'severity'>): string {
  return c.severity ? `${SEVERITY_PREFIX[c.severity]}${c.text}` : c.text
}

/** A posted comment's body: the text plus the hidden marker a retry matches it by. */
export function itemBody(c: PrReviewComment): string {
  return `${withSeverity(c)}\n\n<!-- se:${c.id} -->`
}

/** The draft id a posted comment carries, or null for a comment SimpleEdit didn't write. */
export function itemMarkerOf(body: string): string | null {
  return ITEM_MARKER.exec(body)?.[1] ?? null
}

export function claimMarker(token: string): string {
  return `<!-- se-review:${token} -->`
}

/** A pending review's body without SimpleEdit's claim marker. */
export function withoutClaim(body: string): string {
  return body.replace(CLAIM_MARKER, '').trim()
}

/** FNV-1a, enough to tell two versions of one comment apart. */
function hash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

/** A draft comment's version as a whole, wherever it ends up (line, reply or body). */
export function commentRev(c: PrReviewComment): string {
  return hash(JSON.stringify([c.file, c.line ?? null, c.side ?? 'RIGHT', c.text, c.severity ?? null, c.snippet ?? null, c.inReplyTo?.threadNodeId ?? null, c.sha ?? null]))
}

export interface PlannedThread {
  kind: 'thread'
  comment: PrReviewComment
  body: string
  rev: string
  path: string
  line: number
  side: 'LEFT' | 'RIGHT'
  startLine?: number
  startSide?: 'LEFT' | 'RIGHT'
}

export interface PlannedReply {
  kind: 'reply'
  comment: PrReviewComment
  body: string
  rev: string
  threadNodeId: string
  rootCommentId: string
}

export type PlannedItem = PlannedThread | PlannedReply

/**
 * `<where it sits>.<what it says>`: a retry updates a changed body in place,
 * but a changed anchor means the comment has to be posted again.
 */
export function draftRev(anchorKey: string, body: string): string {
  return `${hash(anchorKey)}.${hash(body)}`
}

export function anchorPartOf(rev: string): string {
  return rev.split('.')[0]
}

export interface LayerPlan {
  /** `draft` after `anchorsForHead`: what the body's bullets are built from. */
  draft: PrReviewDraft
  items: PlannedItem[]
  /** Draft ids the anchor checks already sent to the body. */
  folded: string[]
  folds: ReviewFolds
  /** Draft ids that were never on a line: in the body, but not a fold to report. */
  notes: Set<string>
}

/**
 * Run the composer's anchor checks on one layer's draft: a comment read off
 * another head, outside GitHub's diff at `readHead`, or on the old side of an
 * isolated stacked diff folds into the body. Replies skip them; they hang off
 * a thread GitHub already placed.
 */
export function planLayer(draft: PrReviewDraft, readHead: string, opts: Omit<ReviewPayloadOptions, 'headSha'>): LayerPlan {
  const lines = { ...draft, comments: draft.comments.filter((c) => !c.inReplyTo) }
  const checked = anchorsForHead(draft, readHead)
  const items: PlannedItem[] = []
  const folded: string[] = []
  for (const c of checked.comments) {
    if (c.inReplyTo) {
      const body = itemBody(c)
      items.push({ kind: 'reply', comment: c, body, rev: draftRev(`reply ${c.inReplyTo.threadNodeId}`, body), ...c.inReplyTo })
      continue
    }
    const placed = resolveAnchor(c, opts)
    if ('fold' in placed) {
      folded.push(c.id)
      continue
    }
    const { path, line, side, start_line, start_side } = placed.anchor
    const body = itemBody(c)
    items.push({
      kind: 'thread',
      comment: c,
      body,
      rev: draftRev(`${path}:${start_line ?? line}-${line}:${side}`, body),
      path,
      line,
      side,
      ...(start_line !== undefined ? { startLine: start_line, startSide: start_side } : {}),
    })
  }
  return {
    draft: checked,
    items,
    folded,
    folds: reviewFolds(lines, { ...opts, headSha: readHead }),
    notes: new Set(draft.comments.filter((c) => !c.inReplyTo && c.line === undefined).map((c) => c.id)),
  }
}

/** What a folded reply quotes from the thread it was meant for. */
export interface ReplyContext {
  author?: string
  path?: string
  line?: number
  body?: string
}

const QUOTE_LINES = 4

function replyBullet(c: PrReviewComment, prUrl: string, context: ReplyContext | null): string {
  if (!c.inReplyTo) return `- ${withSeverity(c)}`
  const link = `${prUrl}#discussion_r${c.inReplyTo.rootCommentId}`
  const who = context?.author ? ` @${context.author}` : ''
  const where = context?.path ? ` on ${context.path}${context.line ? `:${context.line}` : ''}` : ''
  const quote = (context?.body ?? '')
    .trim()
    .split('\n')
    .filter(Boolean)
    .slice(0, QUOTE_LINES)
    .map((l) => `\n  > ${l}`)
    .join('')
  return `- In reply to${who}${where} (${link}) — ${withSeverity(c)}${quote}`
}

/**
 * The review body: the summary, then a bullet per comment that couldn't go on
 * its line (with file:line and snippet), then the replies that couldn't post.
 */
export function layerBody(
  plan: LayerPlan,
  foldedIds: ReadonlySet<string>,
  prUrl: string,
  replyContext: ReadonlyMap<string, ReplyContext | null> = new Map()
): string {
  const lineComments = plan.draft.comments
    .filter((c) => !c.inReplyTo && foldedIds.has(c.id))
    .map((c) => ({ ...c, text: withSeverity(c) }))
  const base = foldedReviewPayload({ ...plan.draft, comments: lineComments }, {}).body
  const replies = plan.draft.comments
    .filter((c) => c.inReplyTo && foldedIds.has(c.id))
    .map((c) => replyBullet(c, prUrl, replyContext.get(c.id) ?? null))
  if (!replies.length) return base
  return lineComments.length ? `${base}\n${replies.join('\n')}` : [base, replies.join('\n')].filter(Boolean).join('\n\n')
}
