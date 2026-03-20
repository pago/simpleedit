/** Tracks which commit is being reviewed, per worktree. */

interface ReviewTarget {
  hash: string | null  // null = staging
  message: string
}

let _reviews = $state<Map<string, ReviewTarget>>(new Map())

export const diffReviewStore = {
  get(worktreePath: string): ReviewTarget | undefined {
    return _reviews.get(worktreePath)
  }
}

export function startReview(worktreePath: string, target: ReviewTarget): void {
  _reviews = new Map(_reviews)
  _reviews.set(worktreePath, target)
}

export function closeReview(worktreePath: string): void {
  _reviews = new Map(_reviews)
  _reviews.delete(worktreePath)
}
