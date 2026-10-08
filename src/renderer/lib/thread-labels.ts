import type { AgentThread, ThreadAnchor, ThreadMessage } from '../../shared/agent-threads'

/** What the user sees about where a message is on its way to the agent. */
export interface DeliveryInfo {
  label: string
  tone: 'muted' | 'waiting' | 'ok' | 'error'
  /** `draft`: offer the "my prompt is empty" escape hatch. `retry`: offer Retry. */
  action?: 'force-send' | 'retry'
}

export function deliveryInfo(m: ThreadMessage): DeliveryInfo | null {
  if (m.author !== 'user' || !m.delivery) return null
  switch (m.delivery) {
    case 'held':
      switch (m.heldReason) {
        case 'dialog':
          return { label: 'waiting: the agent is asking you something', tone: 'waiting' }
        case 'draft':
          return { label: 'held: unsent text in the terminal', tone: 'waiting', action: 'force-send' }
        case 'not-running':
          return { label: 'session not running', tone: 'waiting' }
        default:
          return { label: "waiting for the agent's turn to end", tone: 'waiting' }
      }
    case 'sending':
      return { label: 'sending…', tone: 'muted' }
    case 'delivered':
      return { label: 'delivered', tone: 'muted' }
    case 'answered':
    case 'answered-implicitly':
      return { label: 'answered', tone: 'ok' }
    case 'unanswered':
      return { label: m.failedReason ? `unanswered: ${m.failedReason}` : 'unanswered', tone: 'error', action: 'retry' }
    case 'failed':
      return { label: m.failedReason ? `failed: ${m.failedReason}` : 'failed', tone: 'error', action: 'retry' }
  }
}

/**
 * Agent messages that main attached from the turn's final text because the
 * agent never called `reply_to_thread`: each one answering a user message
 * marked `answered-implicitly`.
 */
export function implicitAnswerIds(thread: AgentThread): Set<string> {
  const ids = new Set<string>()
  let lastUser: ThreadMessage | null = null
  for (const m of thread.messages) {
    if (m.author === 'user') lastUser = m
    else {
      if (lastUser?.delivery === 'answered-implicitly') ids.add(m.id)
      lastUser = null
    }
  }
  return ids
}

export function anchorLabel(anchor: ThreadAnchor): string {
  if (anchor.orphaned) return anchor.path
  const lines = anchor.startLine === anchor.endLine ? `${anchor.startLine}` : `${anchor.startLine}-${anchor.endLine}`
  return `${anchor.path}:${lines}`
}

export function anchorContextLabel(anchor: ThreadAnchor): string | null {
  if (anchor.context === 'file') return null
  return anchor.context.commit === 'uncommitted' ? 'uncommitted' : anchor.context.commit.slice(0, 7)
}
