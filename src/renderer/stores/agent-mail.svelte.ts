/**
 * Agent-to-agent mail queued for each session and not yet read by it, mirrored
 * from main's `agent-message:sent` / `:delivered` events. An idle session with
 * mail waiting is otherwise indistinguishable from one with nothing to do.
 */
let queued = $state<Record<string, string[]>>({})

export function queuedMailCount(terminalId: string): number {
  return queued[terminalId]?.length ?? 0
}

function remove(terminalId: string, messageIds: ReadonlySet<string>): void {
  const current = queued[terminalId]
  if (!current) return
  const rest = current.filter((id) => !messageIds.has(id))
  if (rest.length > 0) {
    queued = { ...queued, [terminalId]: rest }
  } else {
    const { [terminalId]: _removed, ...others } = queued
    queued = others
  }
}

export function initAgentMailListeners(): () => void {
  const offSent = window.api.on('agent-message:sent', ({ messageId, to }) => {
    queued = { ...queued, [to]: [...(queued[to] ?? []), messageId] }
  })
  const offDelivered = window.api.on('agent-message:delivered', ({ terminalId, messageIds }) => {
    remove(terminalId, new Set(messageIds))
  })
  const offExit = window.api.on('pty:exit', ({ id }) => {
    remove(id, new Set(queued[id] ?? []))
  })
  return () => {
    offSent()
    offDelivered()
    offExit()
  }
}
