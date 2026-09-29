/**
 * The wire format between the web bundle's `window.api` shim and the remote
 * server. Shared by `src/main/remote/server.ts` and `src/web/api-shim.ts`, so
 * it lives where both can import it without either depending on the other.
 *
 * Deliberately a thin envelope over the existing IPC channels rather than a
 * REST surface: the shim's whole job is to be indistinguishable from the
 * preload bridge, so anything the renderer can call, it calls by name.
 */

/** Sent once when a socket has joined a client identity. */
export interface HelloFrame {
  kind: 'hello'
  /** The window (`ClientHub`) this socket joined. */
  windowId: number
  /** This socket's own `PtyClientId`. */
  clientKey: string
}

export interface InvokeFrame {
  kind: 'invoke'
  id: number
  channel: string
  args: unknown[]
}

export interface SendFrame {
  kind: 'send'
  channel: string
  args: unknown[]
}

export type ResultFrame =
  | { kind: 'result'; id: number; ok: true; value: unknown }
  | { kind: 'result'; id: number; ok: false; error: string }

/** A main→renderer push, forwarded verbatim from the `ClientHub` fan-out. */
export interface EventFrame {
  kind: 'event'
  channel: string
  data: unknown
}

export type ClientFrame = InvokeFrame | SendFrame
export type ServerFrame = HelloFrame | ResultFrame | EventFrame

export function parseClientFrame(raw: string): ClientFrame | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const frame = parsed as Record<string, unknown>
  if (typeof frame.channel !== 'string') return null
  const args = Array.isArray(frame.args) ? frame.args : []

  if (frame.kind === 'invoke') {
    if (typeof frame.id !== 'number') return null
    return { kind: 'invoke', id: frame.id, channel: frame.channel, args }
  }
  if (frame.kind === 'send') {
    return { kind: 'send', channel: frame.channel, args }
  }
  return null
}
