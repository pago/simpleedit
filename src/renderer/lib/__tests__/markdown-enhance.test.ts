import { describe, it, expect, afterEach } from 'vitest'
import {
  fenceToMonacoLanguage,
  rewriteRelativeImages,
  resolvePosix,
  enhanceCodeBlocks,
} from '../markdown-enhance'
import { MERMAID_CONFIG } from '../mermaid-config'

describe('fenceToMonacoLanguage', () => {
  it('maps common aliases to Monaco language ids', () => {
    expect(fenceToMonacoLanguage('ts')).toBe('typescript')
    expect(fenceToMonacoLanguage('TS')).toBe('typescript')
    expect(fenceToMonacoLanguage('py')).toBe('python')
    expect(fenceToMonacoLanguage('sh')).toBe('shell')
    expect(fenceToMonacoLanguage('c++')).toBe('cpp')
  })

  it('returns null for unknown or blank fences', () => {
    expect(fenceToMonacoLanguage('')).toBeNull()
    expect(fenceToMonacoLanguage('not-a-language')).toBeNull()
  })
})

describe('resolvePosix', () => {
  it('resolves relative segments against a base dir', () => {
    expect(resolvePosix('/repo/docs', './img.png')).toBe('/repo/docs/img.png')
    expect(resolvePosix('/repo/docs', '../assets/x.png')).toBe('/repo/assets/x.png')
  })
})

describe('rewriteRelativeImages', () => {
  function container(html: string): HTMLElement {
    const el = document.createElement('div')
    el.innerHTML = html
    return el
  }

  it('rewrites a relative image to the wt-asset scheme', () => {
    const el = container('<img src="./img.png">')
    rewriteRelativeImages(el, '/repo/docs', '/repo')
    const src = el.querySelector('img')!.getAttribute('src')!
    expect(src.startsWith('wt-asset://local')).toBe(true)
    expect(src).toContain('/repo/docs/img.png')
  })

  it('leaves absolute URLs untouched', () => {
    const el = container('<img src="https://example.com/a.png"><img src="data:image/png;base64,AAA">')
    rewriteRelativeImages(el, '/repo/docs', '/repo')
    const srcs = Array.from(el.querySelectorAll('img')).map((i) => i.getAttribute('src'))
    expect(srcs[0]).toBe('https://example.com/a.png')
    expect(srcs[1]).toBe('data:image/png;base64,AAA')
  })

  it('does not rewrite paths that escape the worktree root', () => {
    const el = container('<img src="../../etc/passwd">')
    rewriteRelativeImages(el, '/repo/docs', '/repo')
    expect(el.querySelector('img')!.getAttribute('src')).toBe('../../etc/passwd')
  })
})

describe('enhanceCodeBlocks: mermaid fences', () => {
  /** Mounted under <body> so a diagram escaping its container is detectable. */
  function mount(html: string): HTMLElement {
    const el = document.createElement('div')
    el.innerHTML = html
    document.body.appendChild(el)
    return el
  }

  function straySvgs(root: HTMLElement): Element[] {
    return Array.from(document.querySelectorAll('svg')).filter((svg) => !root.contains(svg))
  }

  // A leak is a body-level node, so it would otherwise be visible to every
  // later test in this file and turn one regression into several failures.
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('renders a valid diagram inline', async () => {
    const root = mount('<pre><code class="language-mermaid">graph TD\n  A[One] --> B[Two]</code></pre>')
    await enhanceCodeBlocks(root, 1, () => true)
    expect(root.querySelector('.md-mermaid svg')).not.toBeNull()
    expect(straySvgs(root)).toHaveLength(0)
  })

  it('shows an error box for a broken diagram without leaking mermaid’s error SVG into <body>', async () => {
    const root = mount('<pre><code class="language-mermaid">sequenceDiagram\n  ->> not valid ->></code></pre>')
    await enhanceCodeBlocks(root, 2, () => true)
    expect(root.querySelector('pre')).toBeNull()
    expect(root.textContent).toContain('Diagram render failed')
    expect(straySvgs(root)).toHaveLength(0)
    expect(document.body.textContent).not.toContain('Syntax error in text')
  })
})

describe('MERMAID_CONFIG', () => {
  // The gen-UI Diagram.svelte render site shares this object but has no test of
  // its own, so the flag that keeps mermaid's error graphic out of <body> is
  // pinned here for both sites.
  it('suppresses mermaid’s own error rendering', () => {
    expect(MERMAID_CONFIG.suppressErrorRendering).toBe(true)
    expect(MERMAID_CONFIG.securityLevel).toBe('strict')
  })
})
