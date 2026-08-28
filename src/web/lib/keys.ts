/**
 * What a physical key sends — which is not one fixed string.
 *
 * A terminal in **application cursor keys** mode (DECCKM, `CSI ?1h`) expects
 * `ESC O A` for Up where a normal terminal expects `ESC [ A`. Full-screen TUIs
 * set it as a matter of course, so a bar that hard-codes the normal form is
 * sending the wrong bytes exactly where a phone most needs the arrows.
 *
 * Ink and crossterm both accept either form, so today's agents happen to work.
 * That is luck, not the contract: the property is "the bytes a physical key
 * sends", and xterm already knows which mode the terminal is in.
 */
export type AccessoryKey = 'up' | 'down' | 'enter' | 'escape' | 'tab'

export function keyBytes(key: AccessoryKey, applicationCursorKeys: boolean): string {
  // Only the cursor keys change with the mode. Enter, Escape and Tab are the
  // same control characters either way.
  const cursor = applicationCursorKeys ? '\x1bO' : '\x1b['
  switch (key) {
    case 'up': return `${cursor}A`
    case 'down': return `${cursor}B`
    case 'enter': return '\r'
    case 'escape': return '\x1b'
    case 'tab': return '\t'
  }
}
