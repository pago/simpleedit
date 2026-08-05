/**
 * The mermaid config every render site in the renderer initializes with.
 *
 * `suppressErrorRendering` is the load-bearing entry. Without it, a diagram that
 * fails to render leaves mermaid's own "bomb" error SVG orphaned in the DOM: on
 * both failure paths inside `render()` — the source failing to parse, and the
 * renderer failing to draw — mermaid draws its error diagram into the temp node
 * it created and rethrows without removing it. Since we call `render(id, src)`
 * with no container element, that node is a full-width div on `<body>`, so the
 * graphic floats over the app, one per failed render. Every call site catches
 * the throw and renders its own error message, so mermaid's is pure leak.
 */
import type { MermaidConfig } from 'mermaid'

export const MERMAID_CONFIG = {
  startOnLoad: false,
  theme: 'dark',
  securityLevel: 'strict',
  suppressErrorRendering: true,
} as const satisfies MermaidConfig
