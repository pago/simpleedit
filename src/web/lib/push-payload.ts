/**
 * The decisions a service worker makes, as ordinary functions.
 *
 * A service worker is the least testable thing in a web app: it runs in its
 * own global scope, is installed by the browser rather than imported, and its
 * events cannot be constructed by a test. So everything that could be WRONG
 * lives here — what to show, where to go, and whether to focus a tab or open
 * one — and `sw.ts` is left as the thin shell that wires those to events.
 *
 * This module is imported by the worker AND by tests. It must therefore stay
 * free of anything that only exists in one of the two scopes.
 */

/** Exactly what `remote/push.ts` encrypts. Nothing here is trusted blindly. */
export interface PushPayload {
  title: string
  body: string
  terminalId: string
  url: string
}

export interface NotificationPlan {
  title: string
  body: string
  /** Carried in the notification's `data`, so a tap need not parse its tag. */
  terminalId: string
  /**
   * One notification per session. A session that blocks, is answered and
   * blocks again should replace its own entry rather than stack a second one
   * on a lock screen.
   */
  tag: string
  /** Where a tap goes. Absolute, and always same-origin — see `sameOriginUrl`. */
  url: string
  /**
   * Never true.
   *
   * A re-notify re-alerts for a tag already on screen, and the only thing that
   * would achieve here is buzzing twice for one block. Stated as a field, and
   * asserted in the tests, so it cannot drift into a plausible-looking `true`.
   */
  renotify: false
}

/**
 * Fall back rather than throw.
 *
 * A push whose body we cannot parse still means SOMETHING woke the phone, and
 * showing nothing is the one outcome a user reads as "the feature is broken".
 * Web Push also permits an empty body; a browser that delivers one must not
 * leave a silent, permission-consuming push event behind.
 */
export function parsePushPayload(raw: string | null | undefined): PushPayload | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const { title, body, terminalId, url } = parsed as Record<string, unknown>
    if (typeof terminalId !== 'string' || typeof url !== 'string') return null
    return {
      title: typeof title === 'string' && title ? title : 'A session is blocked',
      body: typeof body === 'string' ? body : '',
      terminalId,
      url,
    }
  } catch {
    return null
  }
}

/**
 * Resolve `candidate` against this worker's own scope, refusing anything that
 * leaves the origin.
 *
 * The payload is end-to-end encrypted, so a URL in it came from our own Mac —
 * but "it came from us" is a property of the crypto, not of this function, and
 * a notification that can be made to open an arbitrary page is worth the four
 * lines it costs to make impossible. Enforced where it is used, not promised
 * in a comment above it.
 */
export function sameOriginUrl(candidate: string, scope: string): string {
  const base = new URL(scope)
  try {
    const resolved = new URL(candidate, base)
    if (resolved.origin !== base.origin) return base.toString()
    return resolved.toString()
  } catch {
    return base.toString()
  }
}

export function planNotification(raw: string | null | undefined, scope: string): NotificationPlan {
  const payload = parsePushPayload(raw)
  if (!payload) {
    return {
      title: 'A session needs you',
      body: 'Open SimpleEdit to see which one.',
      tag: 'simpleedit-unknown',
      terminalId: '',
      url: sameOriginUrl(scope, scope),
      renotify: false,
    }
  }
  return {
    title: payload.title,
    body: payload.body,
    tag: `simpleedit-${payload.terminalId}`,
    terminalId: payload.terminalId,
    url: sameOriginUrl(payload.url, scope),
    renotify: false,
  }
}

/**
 * What a tap should do, given the windows this worker can see.
 *
 * Focusing an existing tab and telling it where to go beats opening a second
 * one: the open tab holds a live WebSocket, an xterm buffer and any half-typed
 * reply, and `openWindow` would throw all three away.
 *
 * `navigate` is deliberately absent from the focus case. It reloads the page,
 * which costs exactly what focusing was meant to preserve; the client is
 * messaged instead and moves itself.
 */
export type ClickAction =
  | { kind: 'focus'; clientIndex: number; message: { type: 'open-session'; terminalId: string; url: string } }
  | { kind: 'open'; url: string }

export function planClick(
  url: string,
  terminalId: string,
  clients: { url: string; focused?: boolean }[],
): ClickAction {
  if (clients.length === 0) return { kind: 'open', url }
  // Prefer the tab the user was last looking at; otherwise the first one.
  const focused = clients.findIndex((client) => client.focused)
  return {
    kind: 'focus',
    clientIndex: focused >= 0 ? focused : 0,
    message: { type: 'open-session', terminalId, url },
  }
}

/** The message a focused tab receives. Narrowed here so both sides agree. */
export interface OpenSessionMessage {
  type: 'open-session'
  terminalId: string
  url: string
}

export function isOpenSessionMessage(value: unknown): value is OpenSessionMessage {
  if (typeof value !== 'object' || value === null) return false
  const message = value as Record<string, unknown>
  return message.type === 'open-session' && typeof message.terminalId === 'string'
}

/**
 * The session a URL fragment asks for, or null.
 *
 * Used on load (a tap that opened a fresh tab) and on a message (a tap that
 * focused an existing one), so both paths land in exactly the same place.
 */
export function sessionFromUrl(url: string): string | null {
  let hash: string
  try {
    hash = new URL(url).hash
  } catch {
    hash = url.startsWith('#') ? url : ''
  }
  const match = /(?:^#|[#&])session=([^&]*)/.exec(hash)
  if (!match) return null
  try {
    return decodeURIComponent(match[1]) || null
  } catch {
    return null
  }
}
