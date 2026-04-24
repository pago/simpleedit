/** Tracks which commit is being reviewed, per worktree. */

export type ReviewInitialTab = 'files' | 'findings' | 'tour' | 'plan'

interface ReviewTarget {
  hash: string | null  // null = staging, 'plan' = user plan, 'plan-claude:<terminalId>' = Claude plan
  message: string
  /** Optional initial tab hint for a freshly-opened review. */
  initialTab?: ReviewInitialTab
}

let _reviews = $state<Map<string, ReviewTarget>>(new Map())
/** Stores the previous review target so we can restore it when closing plan mode. */
let _previousReviews = $state<Map<string, ReviewTarget>>(new Map())

export const diffReviewStore = {
  get(worktreePath: string): ReviewTarget | undefined {
    return _reviews.get(worktreePath)
  }
}

export function startReview(worktreePath: string, target: ReviewTarget): void {
  _reviews = new Map(_reviews)
  _reviews.set(worktreePath, target)
}

/**
 * Start a tour review for the given commit (or staging when commitHash is null).
 * Equivalent to startReview but forces the Tour tab to be selected initially.
 */
export function startTourReview(worktreePath: string, commitHash: string | null, message: string): void {
  startReview(worktreePath, { hash: commitHash, message, initialTab: 'tour' })
}

/** Start a plan review, saving the current review state for later restoration. */
export function startPlanReview(worktreePath: string, target: ReviewTarget): void {
  const current = _reviews.get(worktreePath)
  if (current && !isPlanHash(current.hash)) {
    _previousReviews = new Map(_previousReviews)
    _previousReviews.set(worktreePath, current)
  }
  startReview(worktreePath, target)
}

export function closeReview(worktreePath: string): void {
  const current = _reviews.get(worktreePath)

  // If closing a plan view, restore the previous review state
  if (current && isPlanHash(current.hash)) {
    const prev = _previousReviews.get(worktreePath)
    _previousReviews = new Map(_previousReviews)
    _previousReviews.delete(worktreePath)
    if (prev) {
      _reviews = new Map(_reviews)
      _reviews.set(worktreePath, prev)
      return
    }
  }

  _reviews = new Map(_reviews)
  _reviews.delete(worktreePath)
}

/** Check if a hash represents a plan view (user-initiated or Claude-originated). */
export function isPlanHash(hash: string | null): boolean {
  return hash === 'plan' || (hash !== null && hash.startsWith('plan-claude:'))
}

/** Extract the terminal ID from a Claude plan hash, or null if not a Claude plan. */
export function getClaudeTerminalFromHash(hash: string | null): string | null {
  if (hash !== null && hash.startsWith('plan-claude:')) {
    return hash.slice('plan-claude:'.length)
  }
  return null
}
