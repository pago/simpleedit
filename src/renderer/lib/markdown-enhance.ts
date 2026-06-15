/**
 * Post-render enhancement of fenced code blocks in the Markdown preview:
 * mermaid diagrams become inline SVG, other fenced languages get Monaco-themed
 * syntax highlighting. Runs against the live DOM after the sanitized HTML is
 * mounted (see MarkdownPreview).
 *
 * Both pieces reuse dependencies already in the app — `mermaid` (also used by
 * the gen-ui Diagram component) and `monaco-editor` (always loaded for the
 * editor). Mermaid runs with `securityLevel: 'strict'` and its SVG is still
 * re-sanitized with DOMPurify before injection (defense-in-depth);
 * `monaco.editor.colorize` only re-wraps our own already-escaped text.
 */
import * as monaco from 'monaco-editor'
import DOMPurify from 'dompurify'

/** Fenced-code info string → Monaco language id. Unknown/blank → null (left as-is). */
const LANG_ALIAS: Record<string, string> = {
  ts: 'typescript', typescript: 'typescript', tsx: 'typescript',
  js: 'javascript', javascript: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json',
  html: 'html', htm: 'html', xml: 'xml', svg: 'xml',
  css: 'css', scss: 'scss', less: 'less',
  md: 'markdown', markdown: 'markdown',
  sh: 'shell', bash: 'shell', zsh: 'shell', shell: 'shell',
  py: 'python', python: 'python',
  rs: 'rust', rust: 'rust', go: 'go', golang: 'go',
  yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini',
  sql: 'sql', graphql: 'graphql', gql: 'graphql',
  java: 'java', c: 'c', cpp: 'cpp', 'c++': 'cpp', cs: 'csharp', csharp: 'csharp',
  rb: 'ruby', ruby: 'ruby', php: 'php', swift: 'swift', kotlin: 'kotlin', kt: 'kotlin',
  dockerfile: 'dockerfile', diff: 'diff',
}

export function fenceToMonacoLanguage(info: string): string | null {
  return LANG_ALIAS[info.trim().toLowerCase()] ?? null
}

const ASSET_SCHEME = 'wt-asset'

/** Resolve a relative POSIX path against a base directory, collapsing `.`/`..`. */
export function resolvePosix(baseDir: string, rel: string): string {
  const stack = baseDir.split('/').filter(Boolean)
  for (const part of rel.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') stack.pop()
    else stack.push(part)
  }
  return '/' + stack.join('/')
}

function assetUrl(absPath: string): string {
  return ASSET_SCHEME + '://local' + absPath.split('/').map(encodeURIComponent).join('/')
}

/**
 * Rewrite relative `<img src>` to the `wt-asset:` protocol so worktree-local
 * images load in both dev (http page) and packaged (file page) builds. Absolute
 * URLs (http/https/data/protocol-relative) are left untouched, and paths that
 * resolve outside `worktreeRoot` are left as-is rather than served.
 */
export function rewriteRelativeImages(root: HTMLElement, fileDir: string, worktreeRoot: string): void {
  const imgs = Array.from(root.querySelectorAll('img'))
  for (const img of imgs) {
    const src = img.getAttribute('src')
    if (!src) continue
    if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('//')) continue
    const abs = src.startsWith('/') ? src : resolvePosix(fileDir, src)
    const normalizedRoot = worktreeRoot.replace(/\/+$/, '')
    if (abs !== normalizedRoot && !abs.startsWith(normalizedRoot + '/')) continue
    img.setAttribute('src', assetUrl(abs))
  }
}

function langOf(code: HTMLElement): string {
  for (const cls of code.classList) {
    if (cls.startsWith('language-')) return cls.slice('language-'.length)
  }
  return ''
}

let mermaidReady = false
async function renderMermaid(code: string, id: string): Promise<string> {
  const { default: mermaid } = await import('mermaid')
  if (!mermaidReady) {
    mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' })
    mermaidReady = true
  }
  const { svg } = await mermaid.render(id, code)
  return svg
}

/**
 * Enhance every fenced code block under `root`. Async work is guarded by
 * `isCurrent(token)` so a newer render (from a live edit) cancels stale DOM
 * writes. Best-effort: any failure leaves the original block in place.
 */
export async function enhanceCodeBlocks(
  root: HTMLElement,
  token: number,
  isCurrent: (t: number) => boolean,
): Promise<void> {
  const blocks = Array.from(root.querySelectorAll('pre > code')) as HTMLElement[]
  for (let i = 0; i < blocks.length; i++) {
    const code = blocks[i]
    const pre = code.parentElement
    if (!pre) continue
    const lang = langOf(code)
    const text = code.textContent ?? ''

    if (lang === 'mermaid') {
      try {
        const svg = await renderMermaid(text, `md-mermaid-${token}-${i}`)
        if (!isCurrent(token) || !pre.isConnected) return
        const wrap = document.createElement('div')
        wrap.className = 'md-mermaid not-prose my-4 overflow-x-auto rounded border border-zinc-800 bg-zinc-900 p-2'
        wrap.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true, html: true } })
        pre.replaceWith(wrap)
      } catch (err) {
        if (!isCurrent(token) || !pre.isConnected) return
        const box = document.createElement('div')
        box.className = 'not-prose my-4 rounded border border-red-800/50 bg-red-950/30 p-3 text-xs text-red-300'
        box.textContent = `Diagram render failed: ${err instanceof Error ? err.message : String(err)}`
        pre.replaceWith(box)
      }
      continue
    }

    const monacoLang = fenceToMonacoLanguage(lang)
    if (!monacoLang) continue
    try {
      const html = await monaco.editor.colorize(text, monacoLang, {})
      if (!isCurrent(token) || !code.isConnected) return
      code.innerHTML = html
    } catch {
      // leave the plain block
    }
  }
}
