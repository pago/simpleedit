/**
 * QR encoding for pairing a phone.
 *
 * The only consumer is the Remote access pane, and what it encodes is a URL
 * with a bearer token in it. Two consequences shape this module:
 *
 *  - **Nothing here logs.** Not the text, not a truncation of it, not on the
 *    error path. A QR is a credential rendered as pixels.
 *  - **The matrix is returned, never markup.** The pane draws it as ordinary
 *    SVG elements, so no string built from the URL is ever handed to `@html`.
 *
 * `uqr` does the encoding — 80 KB installed, zero dependencies, pure
 * TypeScript. Writing Reed–Solomon by hand to save a dependency would be the
 * wrong trade.
 */
import { encode } from 'uqr'

export interface QrMatrix {
  /** Modules per side, border included. */
  size: number
  /** An SVG path in a `0 0 size size` viewBox, one square per dark module. */
  path: string
}

/**
 * Error correction level.
 *
 * `M` rather than the default `L`: this is scanned off a laptop screen at
 * arm's length, in whatever light the room has, and 15% recovery costs a few
 * more modules. A URL with a 64-hex token is long enough that the version
 * bump matters less than the read succeeding first time.
 */
const ECC = 'M'

/** Quiet zone, in modules. The spec's minimum is 4 and scanners rely on it. */
const BORDER = 4

/**
 * Encode `text` as a QR matrix.
 *
 * Throws when the text will not fit any version — the caller decides what to
 * show instead, because the alternative is a QR that silently scans to
 * nothing.
 */
export function qrMatrix(text: string): QrMatrix {
  const result = encode(text, { ecc: ECC, border: BORDER })
  let path = ''
  for (let y = 0; y < result.data.length; y++) {
    const row = result.data[y]
    for (let x = 0; x < row.length; x++) {
      if (row[x]) path += `M${x} ${y}h1v1h-1z`
    }
  }
  return { size: result.size, path }
}
