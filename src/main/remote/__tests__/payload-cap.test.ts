import { describe, it, expect } from 'vitest'
import { capDiffForRemote, REMOTE_DIFF_MAX_BYTES } from '../payload-cap'
import { DIFF_TRUNCATED_MARKER } from '../../../shared/ipc-types'

/**
 * A reply big enough to disconnect the client that asked for it.
 *
 * The socket a phone reads a diff over is the SAME one its terminal streams
 * on, and `SocketTransport.post` closes it once the buffer passes a megabyte.
 * So an uncapped diff does not merely arrive slowly — it drops the client, and
 * the terminal with it.
 */

const line = (n: number): string => `+${'x'.repeat(80)} ${n}`

/** A diff of `count` lines, each a plausible hunk line. */
function bigDiff(count: number): string {
  return ['diff --git a/f b/f', '@@ -1 +1 @@', ...Array.from({ length: count }, (_, i) => line(i))].join('\n')
}

describe('capDiffForRemote', () => {
  it('passes a diff that fits through untouched', () => {
    const small = bigDiff(10)
    expect(capDiffForRemote(small)).toBe(small)
    expect(capDiffForRemote(small)).not.toContain(DIFF_TRUNCATED_MARKER)
  })

  it('keeps an oversized diff under the budget, marker included', () => {
    const capped = capDiffForRemote(bigDiff(200_000))
    expect(Buffer.byteLength(capped, 'utf8')).toBeLessThanOrEqual(REMOTE_DIFF_MAX_BYTES)
    expect(capped).toContain(DIFF_TRUNCATED_MARKER)
  })

  it('cuts on a line boundary, because half a hunk line is a corrupt diff', () => {
    const capped = capDiffForRemote(bigDiff(200_000))
    const body = capped.slice(0, capped.indexOf(DIFF_TRUNCATED_MARKER)).trimEnd()
    for (const kept of body.split('\n').slice(2)) {
      // Every surviving line is one the generator produced, whole.
      expect(kept).toMatch(/^\+x{80} \d+$/)
    }
  })

  it('still says something when the whole budget is one line', () => {
    const capped = capDiffForRemote(`+${'x'.repeat(REMOTE_DIFF_MAX_BYTES * 2)}`)
    expect(Buffer.byteLength(capped, 'utf8')).toBeLessThanOrEqual(REMOTE_DIFF_MAX_BYTES)
    expect(capped).toContain(DIFF_TRUNCATED_MARKER)
  })

  it('measures bytes, not characters, and never cuts one in half', () => {
    // Sized to sit in the GAP: 400 emoji are 800 UTF-16 units — under a
    // 1024 budget counted either of the wrong ways — but 1600 bytes on the
    // wire, which is what the socket's buffer actually holds. A length-based
    // check waves this straight through at well over the cap.
    const astral = `${'🙂'.repeat(400)}\n`
    expect(astral.length).toBeLessThan(1024)
    expect(Buffer.byteLength(astral, 'utf8')).toBeGreaterThan(1024)

    const capped = capDiffForRemote(astral, 1024)
    expect(Buffer.byteLength(capped, 'utf8')).toBeLessThanOrEqual(1024)
    expect(capped).toContain(DIFF_TRUNCATED_MARKER)
    expect(capped).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
    expect(capped).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
  })

  it('is idempotent, so a capped diff is not capped again', () => {
    const once = capDiffForRemote(bigDiff(200_000))
    expect(capDiffForRemote(once)).toBe(once)
  })
})
