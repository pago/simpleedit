/**
 * The one funnel every `agent:status` push goes through.
 *
 * Four places in main report a lifecycle change — the OSC-title parser, the
 * PTY's own spawn/exit bookkeeping, an attached provider's control channel,
 * and the hook endpoint. Before this module they each called
 * `client.send('agent:status', …)` directly, which is fine while the only
 * consumer is a renderer that draws a dot. It stops being fine the moment
 * something ACTS on the transition: a push notification wired into three of
 * the four would be silent for the fourth, and silently — the failure would
 * look exactly like an agent that never blocked.
 *
 * So the send and the observation happen together, or not at all. A provider
 * added later gets the notification trigger by using the same funnel every
 * other one already uses, rather than by remembering to.
 *
 * Watchers are told about a transition even when the client is gone. A PTY
 * outlives the window that spawned it, and an agent that blocks after its
 * window closed is still an agent blocked on the user.
 */
import type { RemoteClient } from './client-hub'
import type { AgentStatusEvent } from '../shared/ipc-types'

/** `client` is the identity the event was addressed to — a window id, in effect. */
type Watcher = (event: AgentStatusEvent, client: RemoteClient) => void

const watchers = new Set<Watcher>()

export function onAgentStatus(watcher: Watcher): () => void {
  watchers.add(watcher)
  return () => {
    watchers.delete(watcher)
  }
}

export function sendAgentStatus(client: RemoteClient, event: AgentStatusEvent): void {
  if (!client.isDestroyed()) client.send('agent:status', event)
  // Snapshot: a watcher may unsubscribe itself from inside its own callback.
  for (const watcher of [...watchers]) {
    try {
      watcher(event, client)
    } catch (error) {
      // A watcher must never be able to break status reporting for everyone
      // else — least of all the notification path, whose whole job is to be
      // there when nobody is watching the screen.
      console.error('[AgentStatus] Watcher threw:', error)
    }
  }
}

/** Exported for tests: drop every watcher, so one suite cannot leak into another. */
export function clearAgentStatusWatchers(): void {
  watchers.clear()
}
