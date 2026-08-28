/**
 * Which URL, if any, is worth putting on a phone's camera.
 *
 * A QR encodes a live bearer token, so the wrong one is not merely useless —
 * it is misleading in a way that costs the user a walk to their desk. Two
 * properties are ENFORCED here rather than promised in the pane's copy:
 *
 *  - **Never loopback.** `http://127.0.0.1:<port>/<token>/` scans perfectly
 *    and resolves, on the phone, to the phone. The check is on the URL's own
 *    host, not on a flag the caller passed, because the flag is the thing most
 *    likely to be wrong.
 *  - **Nothing when remote access is off.** No server, no token, no code.
 *
 * The preference order is HTTPS-over-Serve first: `getUserMedia` needs a
 * secure context, so dictation only exists on that URL.
 */

export interface PairingInput {
  /** Is the server listening right now? */
  running: boolean
  /** The URL the server is bound to, token included. Null when stopped. */
  directUrl: string | null
  /** True when the bound address belongs to the Tailscale interface. */
  boundToTailscale: boolean
  /** The HTTPS URL `tailscale serve` publishes, token included, when active. */
  serveUrl: string | null
}

export interface PairingTarget {
  /** What to encode, or null when nothing here is scannable. */
  url: string | null
  /** An HTTPS origin — the only kind where the microphone will open. */
  secure: boolean
  /** Why there is no code, or the caveat on the one there is. */
  note: string | null
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0'])

/**
 * Is this URL one a *different* device could reach?
 *
 * Parsed, not pattern-matched: `http://127.0.0.1:5173/x/` and
 * `http://127.0.0.1.evil.test/` differ only in a place a substring test misses.
 * An unparseable URL is treated as unreachable — refusing to show a code is
 * always the safe answer.
 */
export function isPhoneReachable(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return !LOOPBACK_HOSTS.has(parsed.hostname)
}

export function pairingTarget(input: PairingInput): PairingTarget {
  if (!input.running) {
    return { url: null, secure: false, note: null }
  }
  if (input.serveUrl && isPhoneReachable(input.serveUrl)) {
    return { url: input.serveUrl, secure: input.serveUrl.startsWith('https://'), note: null }
  }
  if (input.directUrl && input.boundToTailscale && isPhoneReachable(input.directUrl)) {
    return {
      url: input.directUrl,
      secure: false,
      note:
        'This is plain HTTP over the tailnet. It works, but a browser will not call it a secure context, so dictation stays unavailable — turn on Tailscale Serve for an HTTPS address.',
    }
  }
  return {
    url: null,
    secure: false,
    note: input.boundToTailscale
      ? 'There is no address a phone can reach yet.'
      : 'Remote access is bound to this Mac only, so there is nothing for a phone to scan. Pick the Tailscale address below, and turn on Tailscale Serve for HTTPS.',
  }
}
