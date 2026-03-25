import type { TourStatus, TourTopic, Tour } from '../../shared/ipc-types'

export interface TourState {
  status: TourStatus
  overview: string
  topics: TourTopic[]
  editedOverview?: string
  error?: string
}

export function tourKey(worktreePath: string, commitHash: string | null): string {
  return `${worktreePath}:${commitHash ?? 'staging'}`
}

let _tours = $state<Map<string, TourState>>(new Map())

export const tourStore = {
  get(key: string): TourState | undefined {
    return _tours.get(key)
  },

  setStatus(key: string, status: TourStatus, error?: string): void {
    const existing = _tours.get(key)
    const next = new Map(_tours)
    next.set(key, {
      status,
      overview: existing?.overview ?? '',
      topics: existing?.topics ?? [],
      editedOverview: existing?.editedOverview,
      error,
    })
    _tours = next
  },

  setOverview(key: string, overview: string): void {
    const existing = _tours.get(key)
    if (!existing) return
    const next = new Map(_tours)
    next.set(key, { ...existing, overview })
    _tours = next
  },

  addTopic(key: string, topic: TourTopic): void {
    const existing = _tours.get(key)
    if (!existing) return
    const next = new Map(_tours)
    next.set(key, { ...existing, topics: [...existing.topics, topic] })
    _tours = next
  },

  setEditedOverview(key: string, edited: string): void {
    const existing = _tours.get(key)
    if (!existing) return
    const next = new Map(_tours)
    next.set(key, { ...existing, editedOverview: edited })
    _tours = next
  },

  loadFromCache(key: string, tour: Tour): void {
    const next = new Map(_tours)
    next.set(key, {
      status: 'done' as TourStatus,
      overview: tour.overview,
      topics: tour.topics,
    })
    _tours = next
  },

  clear(key: string): void {
    const next = new Map(_tours)
    next.delete(key)
    _tours = next
  },
}

export async function triggerTour(
  worktreePath: string,
  commitHash: string | null,
  overrideOverview?: string
): Promise<void> {
  const key = tourKey(worktreePath, commitHash)
  tourStore.setStatus(key, 'running')
  await window.api.invoke('tour:start', worktreePath, commitHash, overrideOverview)
}

export async function loadCachedTour(
  worktreePath: string,
  commitHash: string | null
): Promise<boolean> {
  const key = tourKey(worktreePath, commitHash)
  const cached = await window.api.invoke('tour:load', worktreePath, commitHash)
  if (cached) {
    tourStore.loadFromCache(key, cached)
    return true
  }
  return false
}
