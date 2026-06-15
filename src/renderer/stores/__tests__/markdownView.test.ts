import { describe, it, expect } from 'vitest'
import { markdownViewStore } from '../markdownView.svelte'

describe('markdownViewStore', () => {
  it('defaults to rendered for unseen files', () => {
    expect(markdownViewStore.get('/repo/fresh-' + Math.round(performance.now()) + '.md')).toBe('rendered')
  })

  it('stores a per-file mode', () => {
    const p = '/repo/a.md'
    markdownViewStore.set(p, 'hybrid')
    expect(markdownViewStore.get(p)).toBe('hybrid')
  })

  it('remembers the most-recent choice as the default for other files', () => {
    markdownViewStore.set('/repo/b.md', 'raw')
    // A file never explicitly set falls back to the last chosen mode.
    expect(markdownViewStore.get('/repo/unseen-after-raw.md')).toBe('raw')
  })

  it('forgets a stored mode', () => {
    const p = '/repo/c.md'
    markdownViewStore.set(p, 'hybrid')
    markdownViewStore.set('/repo/other.md', 'rendered') // move last-chosen away
    markdownViewStore.forget(p)
    expect(markdownViewStore.get(p)).toBe('rendered') // back to last-chosen default
  })
})
