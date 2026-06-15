import { describe, it, expect } from 'vitest'
import { fenceToMonacoLanguage, rewriteRelativeImages, resolvePosix } from '../markdown-enhance'

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
