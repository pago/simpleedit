/**
 * `focus_block` — jump to another block of the panel you are already reading.
 *
 * Unlike every other catalog action this one never leaves the rendered panel:
 * no MCP bridge, no IPC, no repo. That is the point. A tour's "read in this
 * order" list has to work for a PR that was never checked out, and dropping the
 * reader into an editor tab would end the tour they are halfway through.
 *
 * Two things make the jump actually land:
 *  - A collapsed `Section` renders no children at all, so the target may not be
 *    in the DOM yet. Ancestor sections are opened first, outermost in, waiting
 *    for each to render before reaching for the next.
 *  - `BlockBoundary` is `display: contents`, so it has no box of its own to
 *    scroll to or outline. Its single element child is the real target.
 */

import { tick } from 'svelte'
import type { Spec } from '../../../shared/gen-ui-catalog'

/** Class that flashes the arrival point; see `app.css`. */
export const FLASH_CLASS = 'panel-block-flash'

/** How long the arrival highlight stays on, matching the CSS animation. */
export const FLASH_MS = 1400

/**
 * Ids of the `Section` elements enclosing `blockId`, outermost first.
 *
 * Walks child→parent links rather than recursing down, so a spec whose children
 * form a cycle terminates instead of hanging the renderer.
 */
export function ancestorSectionIds(spec: Spec, blockId: string): string[] {
  const parentOf = new Map<string, string>()
  for (const [key, el] of Object.entries(spec.elements)) {
    for (const child of el.children ?? []) {
      if (!parentOf.has(child)) parentOf.set(child, key)
    }
  }

  const chain: string[] = []
  const seen = new Set<string>([blockId])
  let current = parentOf.get(blockId)
  while (current !== undefined && !seen.has(current)) {
    seen.add(current)
    if (spec.elements[current]?.type === 'Section') chain.unshift(current)
    current = parentOf.get(current)
  }
  return chain
}

function boundaryFor(root: ParentNode, blockId: string): Element | null {
  return root.querySelector(`[data-block-id="${CSS.escape(blockId)}"]`)
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

/**
 * Expand, scroll to and flash `blockId` inside `root`. Resolves to false when
 * the block is not on screen — validation rejects dead links before a panel
 * opens, so in practice that only happens if a `visible` expression hid it.
 */
export async function focusBlock(root: HTMLElement, spec: Spec, blockId: string): Promise<boolean> {
  for (const sectionId of ancestorSectionIds(spec, blockId)) {
    const toggle = boundaryFor(root, sectionId)?.querySelector('[data-section-toggle]')
    if (toggle instanceof HTMLElement && toggle.getAttribute('aria-expanded') === 'false') {
      toggle.click()
      // The section's children only exist after Svelte flushes, and the next
      // section down is one of them.
      await tick()
    }
  }

  const boundary = boundaryFor(root, blockId)
  const target = boundary?.firstElementChild ?? boundary
  if (!(target instanceof HTMLElement)) return false

  target.scrollIntoView({
    block: 'start',
    behavior: prefersReducedMotion() ? 'auto' : 'smooth',
  })

  target.classList.remove(FLASH_CLASS)
  // Restart the animation for a repeat jump to the same block: without the
  // reflow the class re-add is coalesced away and nothing flashes.
  void target.offsetWidth
  target.classList.add(FLASH_CLASS)
  window.setTimeout(() => target.classList.remove(FLASH_CLASS), FLASH_MS)

  return true
}
