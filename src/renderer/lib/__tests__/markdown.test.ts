import { describe, it, expect } from 'vitest'
import { isMarkdownPath, renderMarkdown } from '../markdown'

describe('isMarkdownPath', () => {
  it('matches .md and .markdown case-insensitively', () => {
    expect(isMarkdownPath('/a/b/readme.md')).toBe(true)
    expect(isMarkdownPath('/a/b/NOTES.MARKDOWN')).toBe(true)
    expect(isMarkdownPath('/a/b/file.Md')).toBe(true)
  })

  it('rejects non-markdown and extensionless paths', () => {
    expect(isMarkdownPath('/a/b/index.ts')).toBe(false)
    expect(isMarkdownPath('/a/b/Makefile')).toBe(false)
    expect(isMarkdownPath('/a/b/notes.mdx')).toBe(false)
  })
})

describe('renderMarkdown', () => {
  it('renders headings and inline formatting', () => {
    const html = renderMarkdown('# Title\n\nSome **bold** text.')
    expect(html).toContain('<h1')
    expect(html).toContain('Title')
    expect(html).toContain('<strong>bold</strong>')
  })

  it('strips script tags and inline event handlers', () => {
    const html = renderMarkdown('<script>window.x=1<\/script>\n\n<img src=x onerror="alert(1)">')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('onerror')
  })

  it('annotates top-level blocks with their source line', () => {
    const html = renderMarkdown('# One\n\nparagraph two\n\n## Three')
    expect(html).toContain('data-source-line="1"')
    expect(html).toContain('data-source-line="3"')
    expect(html).toContain('data-source-line="5"')
  })

  it('preserves fenced-code language class for later enhancement', () => {
    const html = renderMarkdown('```ts\nconst a = 1\n```')
    expect(html).toContain('language-ts')
  })
})
