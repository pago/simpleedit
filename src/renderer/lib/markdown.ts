/**
 * Markdown parsing for the preview. `marked` produces the HTML; DOMPurify
 * sanitizes it before it reaches `{@html}`. Block-level elements are tagged
 * with `data-source-line` so the hybrid view can anchor scroll position to the
 * source (see MarkdownView).
 */
import { marked, type TokensList, type Token } from 'marked'
import DOMPurify from 'dompurify'

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown'])

export function isMarkdownPath(path: string): boolean {
  const dot = path.lastIndexOf('.')
  if (dot === -1) return false
  return MARKDOWN_EXTENSIONS.has(path.slice(dot).toLowerCase())
}

function countNewlines(text: string): number {
  let n = 0
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++
  return n
}

/** Inject `data-source-line` into the first opening tag of an HTML fragment. */
function annotateLine(html: string, line: number): string {
  return html.replace(
    /^(\s*)<([a-zA-Z][\w-]*)((?:\s[^>]*?)?)(\s*\/?>)/,
    (_m, ws: string, tag: string, attrs: string, close: string) =>
      `${ws}<${tag}${attrs} data-source-line="${line}"${close}`,
  )
}

/**
 * Render markdown to sanitized HTML, annotating each top-level block with its
 * 1-based source line. Top-level tokens are parsed individually (carrying the
 * shared link-definition table) so we can attribute each rendered block back to
 * a line; this is correct because block tokens are self-contained at top level.
 */
export function renderMarkdown(src: string): string {
  const tokens = marked.lexer(src)
  let html = ''
  let line = 1
  for (const token of tokens) {
    const startLine = line
    line += countNewlines((token as Token & { raw?: string }).raw ?? '')
    const single = [token] as unknown as TokensList
    single.links = tokens.links
    let piece = marked.parser(single)
    if (piece.trim()) piece = annotateLine(piece, startLine)
    html += piece
  }
  // Default config already allows data-* attributes and relative URLs while
  // stripping <script>, event handlers and unknown URI schemes. Relative image
  // srcs are rewritten to the wt-asset: protocol on the live DOM afterwards
  // (MarkdownPreview), so authored wt-asset: URLs stay blocked here.
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } })
}
