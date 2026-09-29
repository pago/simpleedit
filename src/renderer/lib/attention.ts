/**
 * Is the user looking at a given view, in this window, right now?
 *
 * `active` alone is not enough — every session's workspace stays mounted, and
 * a background window's tabs are `active` in their own right. Attention means
 * the tab is the selected one AND the document is visible AND this window is
 * the focused one.
 *
 * Extracted from `Terminal.svelte` so the predicate can be tested against a
 * real document. It gates only CLAIMS (taking over a PTY's size), never sends:
 * main is authoritative about ownership, so a client that guesses wrong here
 * costs nothing but a dropped resize.
 */
export function hasUserAttention(active: boolean, doc: Document = document): boolean {
  return active && !doc.hidden && doc.hasFocus()
}
