import { isReviewId } from './review-room'

export interface SessionOwner {
  kind: 'review'
  reviewId: string
}

export function parseSessionOwner(value: unknown): SessionOwner | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const owner = value as Record<string, unknown>
  return owner.kind === 'review' && isReviewId(owner.reviewId)
    ? { kind: 'review', reviewId: owner.reviewId }
    : undefined
}

export function isOwned(value: { owner?: SessionOwner } | null | undefined): boolean {
  return value?.owner?.kind === 'review'
}
