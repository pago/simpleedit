/**
 * Per-block identity + content extraction for "Discuss this" on a composed
 * panel (#62 follow-up).
 *
 * json-render hands a component its resolved props but not its spec key, so
 * `stampBlockIds` writes the key into a reserved prop that `BlockBoundary`
 * reads back and surfaces as a `data-block-id` DOM anchor. A text selection can
 * then be traced to the block it came from.
 *
 * Blocks carry no file/line anchor on purpose: a Diagram can span a dozen
 * files, so an anchor would be false precision. The block's own content travels
 * with the message instead — Discuss can spawn a *new* session that never saw
 * the panel spec, so a bare block id would mean nothing to the receiver.
 */

import type { Spec } from '../../../shared/gen-ui-catalog'

/** Reserved prop name carrying the element's spec key. Never authored by an agent. */
export const BLOCK_ID_PROP = '__blockId'

/** Copy of `spec` with every element's key stamped into its props. */
export function stampBlockIds(spec: Spec): Spec {
  return {
    root: spec.root,
    elements: Object.fromEntries(
      Object.entries(spec.elements).map(([key, el]) => [
        key,
        { ...el, props: { ...el.props, [BLOCK_ID_PROP]: key } },
      ]),
    ),
  }
}

/**
 * Cap on the content we paste into a terminal. A tour DiffBlock can hold a
 * whole PR diff; the point is a self-contained message, not a full dump.
 */
const MAX_CONTENT_CHARS = 4000

function truncate(text: string): string {
  if (text.length <= MAX_CONTENT_CHARS) return text
  return `${text.slice(0, MAX_CONTENT_CHARS)}\n… (truncated, ${text.length - MAX_CONTENT_CHARS} more characters)`
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function fence(language: string, body: string): string {
  return ['```' + language, body, '```'].join('\n')
}

/**
 * Render a block's props as text an agent that never saw the spec can act on.
 * Prose stays prose; code and diffs get fenced; anything structural falls back
 * to its JSON, which is honest about what the user was looking at.
 */
export function describeBlock(element: Spec['elements'][string] | undefined): string {
  if (!element) return ''
  const props = element.props ?? {}

  switch (element.type) {
    case 'ProseBlock':
      return truncate(str(props['content']))
    case 'Callout':
      return truncate([str(props['title']), str(props['body'])].filter(Boolean).join('\n\n'))
    case 'CodeSnippet':
      return truncate(fence(str(props['language']), str(props['code'])))
    case 'DiffBlock':
      return truncate(fence('diff', str(props['diff'])))
    default: {
      const rest = Object.fromEntries(
        Object.entries(props).filter(([key]) => key !== BLOCK_ID_PROP),
      )
      return truncate(fence('json', JSON.stringify(rest, null, 2)))
    }
  }
}
