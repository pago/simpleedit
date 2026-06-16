import { describe, it, expect } from 'vitest'
import { computeFileLabels } from './fileLabels'

function labels(paths: string[]) {
  const map = computeFileLabels(paths)
  return Object.fromEntries(
    [...map].map(([path, l]) => [path, `${l.secondary}<${l.primary}>`])
  )
}

describe('computeFileLabels', () => {
  it('keeps an ordinary filename as the primary, dir as secondary', () => {
    expect(labels(['src/renderer/components/editor/DiffReview.svelte'])).toEqual({
      'src/renderer/components/editor/DiffReview.svelte':
        'src/renderer/components/editor/<DiffReview.svelte>',
    })
  })

  it('has no secondary for a root-level file', () => {
    expect(labels(['README.md'])).toEqual({ 'README.md': '<README.md>' })
  })

  it('folds the parent dir into context-less names even without a collision', () => {
    expect(labels(['src/renderer/components/editor/DiffReview/index.tsx'])).toEqual({
      'src/renderer/components/editor/DiffReview/index.tsx':
        'src/renderer/components/editor/<DiffReview/index.tsx>',
    })
  })

  it('recognises the next.js / language barrel conventions', () => {
    expect(labels(['app/dashboard/page.tsx'])['app/dashboard/page.tsx']).toBe(
      'app/<dashboard/page.tsx>'
    )
    expect(labels(['pkg/util/mod.rs'])['pkg/util/mod.rs']).toBe('pkg/<util/mod.rs>')
    expect(labels(['pkg/__init__.py'])['pkg/__init__.py']).toBe('<pkg/__init__.py>')
  })

  it('strips the extension chain when detecting context-less stems', () => {
    expect(labels(['comp/Button/index.test.ts'])['comp/Button/index.test.ts']).toBe(
      'comp/<Button/index.test.ts>'
    )
  })

  it('disambiguates two identical filenames by growing the path', () => {
    expect(labels(['src/a/util.ts', 'src/b/util.ts'])).toEqual({
      'src/a/util.ts': 'src/<a/util.ts>',
      'src/b/util.ts': 'src/<b/util.ts>',
    })
  })

  it('grows only as far as needed to break the tie', () => {
    // index files already carry one parent; a collision pushes them one further.
    expect(labels(['x/foo/index.ts', 'x/bar/index.ts'])).toEqual({
      'x/foo/index.ts': 'x/<foo/index.ts>',
      'x/bar/index.ts': 'x/<bar/index.ts>',
    })
  })

  it('keeps growing until unique when intermediate segments also match', () => {
    // They only diverge at the root, so the whole path becomes prominent —
    // the distinguishing segment must never be hidden in the dimmed remainder.
    expect(labels(['a/shared/util.ts', 'b/shared/util.ts'])).toEqual({
      'a/shared/util.ts': '<a/shared/util.ts>',
      'b/shared/util.ts': '<b/shared/util.ts>',
    })
  })

  it('does not over-disambiguate unrelated files', () => {
    expect(labels(['src/a.ts', 'src/b.ts'])).toEqual({
      'src/a.ts': 'src/<a.ts>',
      'src/b.ts': 'src/<b.ts>',
    })
  })

  it('terminates when one colliding path runs out of segments', () => {
    // `util.ts` at the root can never grow; the deeper one grows to stay distinct.
    expect(labels(['util.ts', 'lib/util.ts'])).toEqual({
      'util.ts': '<util.ts>',
      'lib/util.ts': '<lib/util.ts>',
    })
  })
})
