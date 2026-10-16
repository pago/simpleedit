import { isReviewId } from './review-room'
import { isWorkflowId, isWorkflowTaskId } from './workflow'

/**
 * Who a hidden session belongs to. An owned session never appears in the
 * sidebar and is never selected; its owner shows it instead.
 *
 * - `review`: a Review Room companion, hidden outright.
 * - `workflow`: a workflow task's worker. Its attention rolls up onto the
 *   workflow's lead, and its Workflow tab card opens it. `attempt` tells a
 *   retry's worker from the one it replaced, which stays until Dismiss.
 */
export type SessionOwner =
  | { kind: 'review'; reviewId: string }
  | { kind: 'workflow'; workflowId: string; taskId: string; attempt: number }

export type WorkflowOwner = Extract<SessionOwner, { kind: 'workflow' }>

export function parseSessionOwner(value: unknown): SessionOwner | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const owner = value as Record<string, unknown>
  if (owner.kind === 'review') {
    return isReviewId(owner.reviewId) ? { kind: 'review', reviewId: owner.reviewId } : undefined
  }
  if (owner.kind === 'workflow') {
    const attempt = owner.attempt
    return isWorkflowId(owner.workflowId) &&
      isWorkflowTaskId(owner.taskId) &&
      typeof attempt === 'number' &&
      Number.isInteger(attempt) &&
      attempt >= 1
      ? { kind: 'workflow', workflowId: owner.workflowId, taskId: owner.taskId, attempt }
      : undefined
  }
  return undefined
}

/** A plain copy for IPC: a store's `owner` is a `$state` proxy, which structured clone refuses. */
export function plainSessionOwner(owner: SessionOwner): SessionOwner {
  return owner.kind === 'review'
    ? { kind: 'review', reviewId: owner.reviewId }
    : { kind: 'workflow', workflowId: owner.workflowId, taskId: owner.taskId, attempt: owner.attempt }
}

export function isOwned(value: { owner?: SessionOwner } | null | undefined): boolean {
  return value?.owner !== undefined
}

export function workflowOwner(value: { owner?: SessionOwner } | null | undefined): WorkflowOwner | undefined {
  return value?.owner?.kind === 'workflow' ? value.owner : undefined
}
