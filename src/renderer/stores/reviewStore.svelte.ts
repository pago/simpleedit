import type { ReviewFinding, ReviewStatus } from '../../shared/ipc-types'

export interface ReviewState {
  status: ReviewStatus
  findings: ReviewFinding[]
  dismissed: Set<string>
  error?: string
}

export function reviewKey(worktreePath: string, commitHash: string | null): string {
  return `${worktreePath}:${commitHash ?? 'staging'}`
}

let _reviews = $state<Map<string, ReviewState>>(new Map())

export const reviewStore = {
  get(key: string): ReviewState | undefined {
    return _reviews.get(key)
  },

  setStatus(key: string, status: ReviewStatus, error?: string): void {
    const existing = _reviews.get(key)
    const next = new Map(_reviews)
    next.set(key, {
      status,
      findings: existing?.findings ?? [],
      dismissed: existing?.dismissed ?? new Set(),
      error,
    })
    _reviews = next
  },

  addFinding(key: string, finding: ReviewFinding): void {
    const existing = _reviews.get(key)
    if (!existing) return
    const next = new Map(_reviews)
    next.set(key, { ...existing, findings: [...existing.findings, finding] })
    _reviews = next
  },

  dismiss(key: string, findingId: string): void {
    const existing = _reviews.get(key)
    if (!existing) return
    const next = new Map(_reviews)
    const dismissed = new Set(existing.dismissed)
    dismissed.add(findingId)
    next.set(key, { ...existing, dismissed })
    _reviews = next
  },

  undismiss(key: string, findingId: string): void {
    const existing = _reviews.get(key)
    if (!existing) return
    const next = new Map(_reviews)
    const dismissed = new Set(existing.dismissed)
    dismissed.delete(findingId)
    next.set(key, { ...existing, dismissed })
    _reviews = next
  },

  clear(key: string): void {
    const next = new Map(_reviews)
    next.delete(key)
    _reviews = next
  },
}

export async function triggerReview(
  worktreePath: string,
  commitHash: string | null
): Promise<void> {
  const key = reviewKey(worktreePath, commitHash)
  reviewStore.setStatus(key, 'running')
  await window.api.invoke('review:start', worktreePath, commitHash)
}
