import type { AgentStatus } from '../../shared/ipc-types'

/** Most-urgent-first: the aggregate shows the first level any session reaches. */
export type AttentionLevel = 'error' | 'waiting' | 'unseen' | 'running' | 'none'

export type AttentionCounts = Record<Exclude<AttentionLevel, 'none'>, number>

/** What one agent session contributes to the aggregate. */
export interface SessionAttentionSummary {
  exited: boolean
  status: AgentStatus
  unseen: boolean
}

export interface SessionsAttention {
  level: AttentionLevel
  counts: AttentionCounts
}

const PRECEDENCE: Exclude<AttentionLevel, 'none'>[] = ['error', 'waiting', 'unseen', 'running']

export function sessionAttentionLevel(s: SessionAttentionSummary): AttentionLevel {
  if (s.exited || s.status === 'error') return 'error'
  if (s.status === 'waiting') return 'waiting'
  if (s.status === 'idle' && s.unseen) return 'unseen'
  if (s.status === 'running') return 'running'
  return 'none'
}

export function sessionsAttention(sessions: readonly SessionAttentionSummary[]): SessionsAttention {
  const counts: AttentionCounts = { error: 0, waiting: 0, unseen: 0, running: 0 }
  for (const s of sessions) {
    const level = sessionAttentionLevel(s)
    if (level !== 'none') counts[level]++
  }
  return { level: PRECEDENCE.find((l) => counts[l] > 0) ?? 'none', counts }
}

const LABELS: Record<Exclude<AttentionLevel, 'none'>, string> = {
  error: 'crashed or errored',
  waiting: 'awaiting input',
  unseen: 'finished',
  running: 'working',
}

/** e.g. "2 awaiting input · 1 finished" */
export function attentionTooltip(counts: AttentionCounts): string {
  const parts = PRECEDENCE.filter((l) => counts[l] > 0).map((l) => `${counts[l]} ${LABELS[l]}`)
  return parts.length > 0 ? parts.join(' · ') : 'Nothing needs attention'
}
