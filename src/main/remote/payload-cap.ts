/**
 * Bounding what a socket client can ask main to send it.
 *
 * A remote client shares ONE socket with its terminal. `SocketTransport.post`
 * closes that socket with 1013 as soon as `bufferedAmount` passes a megabyte,
 * which is right — a client that cannot drain must not silently miss events —
 * but it means an oversized reply is not merely slow: it disconnects the
 * client, taking the live PTY stream with it. A diff has no upper bound at
 * all, so one large commit is enough.
 *
 * That is why this is enforced here rather than in the component that asks.
 * The constraint belongs to the transport, and the transport is only visible
 * on this side.
 *
 * Deliberately NOT applied to the window's own renderer: it reaches these
 * handlers over Electron IPC, where none of this applies, and it renders diffs
 * in Monaco. Capping there would be a regression in the surface that exists to
 * read them.
 */
import { DIFF_TRUNCATED_MARKER } from '../../shared/ipc-types'

/**
 * The budget for one diff sent over a socket.
 *
 * Well under `MAX_BUFFERED_BYTES` because the diff is not alone on the wire:
 * the terminal is streaming `pty:data` over the same socket, and it is the
 * NEXT frame after a big reply that trips the cap. Also far more than anyone
 * can read on a phone, so the cap costs nothing a reader wanted.
 */
export const REMOTE_DIFF_MAX_BYTES = 256 * 1024

/** The longest prefix of `text` that fits in `maxBytes` as UTF-8. */
function bytePrefix(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  // A character is at most 4 bytes, so the answer is within the first
  // `maxBytes` CHARACTERS — which bounds the search without measuring the
  // whole string, and diffs here are the ones big enough to matter.
  let low = 0
  let high = Math.min(text.length, maxBytes)
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= maxBytes) low = mid
    else high = mid - 1
  }
  // Never end on a high surrogate: half a character is a replacement glyph.
  return text.slice(0, /[\uD800-\uDBFF]$/.test(text.slice(0, low)) ? low - 1 : low)
}

/**
 * A diff bounded for a socket, saying so where it was cut.
 *
 * Cut on a LINE boundary: half a hunk line is not a smaller diff, it is a
 * corrupt one, and the parser on the other side has no way to tell. The marker
 * is part of the returned string rather than a flag beside it so that a client
 * which does nothing special still shows the reader that something is missing.
 */
export function capDiffForRemote(diff: string, maxBytes: number = REMOTE_DIFF_MAX_BYTES): string {
  if (Buffer.byteLength(diff, 'utf8') <= maxBytes) return diff
  const marker = `\n${DIFF_TRUNCATED_MARKER}\n`
  const budget = Math.max(0, maxBytes - Buffer.byteLength(marker, 'utf8'))
  const head = bytePrefix(diff, budget)
  const lastNewline = head.lastIndexOf('\n')
  // No newline in the whole budget means one pathological line; a
  // character-safe cut is the best available, and the marker still explains it.
  return `${lastNewline >= 0 ? head.slice(0, lastNewline) : head}${marker}`
}
