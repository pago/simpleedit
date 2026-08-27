import type { PtyClientId } from '../../shared/ipc-types'

/**
 * This transport's own `PtyClientId`, fetched once per document.
 *
 * A window's renderer and a phone attached to the same session share one
 * `ClientHub`, so `pty:owner-changed` reaches both — each has to compare the
 * announced owner against its own key to know which of them it names.
 */
let pending: Promise<PtyClientId> | undefined

export function clientKey(): Promise<PtyClientId> {
  if (pending) return pending
  const p: Promise<PtyClientId> = window.api.invoke('app:client-key')
  pending = p
  return p
}
