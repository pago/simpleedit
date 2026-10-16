/**
 * The Review Room's IPC surface beyond `review:load` / `review:op`: what the
 * desktop room (and, from PR 4, the phone) asks main to do. Everything here is
 * a main function, never a client op: opening a review resolves its stack,
 * companion creation is claimed by main, and posting runs in main.
 *
 * Every request arrives from a client (the phone is a remote one), so main
 * parses each payload as untrusted.
 */
import type { InteractiveTarget } from './ipc-types'
import type { BaseAnalysis, PrCiStatus } from './screenprs'
import type { ReviewSeverity } from './review-room'

/** What the room shows about one layer, without its diff (fetched per layer). */
export interface ReviewLayerInfo {
  url: string
  owner: string
  repo: string
  number: number
  title: string
  author: string
  isDraft: boolean
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  baseRefName: string
  headRefName: string
  headSha: string
  additions: number
  deletions: number
  changedFiles: number
  ci: PrCiStatus
  body: string
  base?: BaseAnalysis
}

export interface ReviewOpenResult {
  reviewId: string
  /** Bottom → top. */
  layers: ReviewLayerInfo[]
}

export interface ReviewLayerDiff {
  url: string
  headSha: string
  diff: string
  base?: BaseAnalysis
}

/** §8: how the layer's head relates to the head the user last looked at. */
export type ReviewSinceStatus =
  | { kind: 'first-visit' }
  | { kind: 'identical' }
  | { kind: 'ahead'; aheadBy: number; from: string; to: string }
  | { kind: 'behind'; from: string; to: string }
  | { kind: 'rewritten'; from: string; to: string }
  | { kind: 'unknown'; error: string }

export type ReviewVerdict = 'approve' | 'comment' | 'request_changes'

export interface ReviewSubmitRequest {
  reviewId: string
  layers: Array<{
    prUrl: string
    verdict: ReviewVerdict
    /** The head the user read the layer at. Main posts only if it is still the review's recorded head. */
    readHead: string
    /**
     * The user answered "use it" to a pending review on GitHub that SimpleEdit
     * didn't create: its node id. Absent means stop and ask.
     */
    adoptPendingReviewId?: string
  }>
}

export type ReviewLayerSubmitOutcome =
  | { prUrl: string; kind: 'posted'; reviewUrl?: string; folded: number }
  | { prUrl: string; kind: 'skipped' }
  /** A pending review exists that SimpleEdit didn't create; nothing was added. */
  | { prUrl: string; kind: 'foreign-pending'; pendingReviewId: string; commentCount: number }
  | { prUrl: string; kind: 'failed'; error: string }
  /** The layer's head changed since the user read it; nothing was posted. Reload the layer first. */
  | { prUrl: string; kind: 'head-moved'; readHead: string; headSha: string }
  /** Timed out: GitHub may or may not have it. A retry resumes by marker. */
  | { prUrl: string; kind: 'unknown'; error: string }

export interface ReviewSubmitResult {
  layers: ReviewLayerSubmitOutcome[]
  /** True once every layer posted (or was skipped): the review is `submitted`. */
  complete: boolean
}

/** Main → the renderer of the window that won `claimCompanion`. */
export interface ReviewCompanionCreateRequest {
  correlationId: string
  reviewId: string
  /** The terminal id main reserved in the claim; the session must use it. */
  sessionId: string
  target: InteractiveTarget
  brief: string
  label: string
}

export type ReviewCompanionCreateOutcome = { ok: true } | { ok: false; reason: string }

/** The room's view of its companion, derived by main (status comes from the renderer's own store). */
export interface ReviewCompanionInfo {
  reviewId: string
  sessionId: string
  windowId: number
  /** True when the asking window is the one hosting the terminal. */
  hostedHere: boolean
  /**
   * The claimed session has a live PTY. False after a restart (the claim
   * survives quit): the hosting window's placeholder offers Resume; with no
   * placeholder, `review:companion-start` replaces the stale claim.
   */
  live: boolean
  /** How read-only is enforced for this provider (tooltip). */
  readOnly: 'enforced' | 'by-instruction'
}

export type { ReviewSeverity }
