import { describe, it, expect } from 'vitest'
import { makeLensTask, synthesisTask, _parseFinding } from '../deep-review-lenses'
import type { PrContext, DeepFinding } from '../../../shared/screenprs'

const ctx: PrContext = {
  owner: 'acme', repo: 'ui', number: 3, url: 'u', title: 'Add retry', author: 'a', updatedAt: 'd',
  additions: 20, deletions: 2, changedFiles: 2, baseRefName: 'main',
  ci: 'green', ciFailing: [], reviewers: [], approvedByOther: false,
  body: 'adds retry to the client', diff: 'diff --git a/x b/x\n+ retry()',
}

describe('_parseFinding', () => {
  it('injects the lens for a lens task and validates fields', () => {
    const f = _parseFinding('soundness', { severity: 'blocking', file: 'a.ts', line: 5, title: 'npe', detail: 'guard it' })
    expect(f).toEqual({ lens: 'soundness', severity: 'blocking', file: 'a.ts', line: '5', title: 'npe', detail: 'guard it' })
  })
  it('rejects bad severity or missing fields', () => {
    expect(_parseFinding('tests', { severity: 'huge', file: 'a', title: 't', detail: 'd' })).toBeNull()
    expect(_parseFinding('tests', { severity: 'note', file: '', title: 't', detail: 'd' })).toBeNull()
    expect(_parseFinding('tests', { severity: 'note', file: 'a', title: 't' })).toBeNull() // no detail
  })
  it('for synthesis (lens=null) requires a valid lens field on the object', () => {
    expect(_parseFinding(null, { severity: 'note', file: 'a', title: 't', detail: 'd' })).toBeNull()
    const f = _parseFinding(null, { lens: 'types', severity: 'concern', file: 'a', title: 't', detail: 'd' })
    expect(f?.lens).toBe('types')
    expect(_parseFinding(null, { lens: 'nonsense', severity: 'note', file: 'a', title: 't', detail: 'd' })).toBeNull()
  })
})

describe('makeLensTask', () => {
  it('builds a lens-specific prompt embedding the diff + description', () => {
    const task = makeLensTask('tests')
    const { user } = task.buildPrompt(ctx)
    expect(user).toContain('TEST COVERAGE')
    expect(user).toContain('adds retry to the client')
    expect(user).toContain('+ retry()')
    expect(user).toContain('NDJSON')
  })
  it('soundness and architecture get distinct instructions', () => {
    expect(makeLensTask('soundness').buildPrompt(ctx).user).toContain('SOUNDNESS')
    expect(makeLensTask('architecture').buildPrompt(ctx).user).toContain('ARCHITECTURE')
  })
  it('tags parsed findings with its own lens', () => {
    const task = makeLensTask('intent')
    expect(task.parse({ severity: 'note', file: 'a', title: 't', detail: 'd' })?.lens).toBe('intent')
  })
})

describe('synthesisTask', () => {
  it('embeds the raw findings and the diff', () => {
    const raw: DeepFinding[] = [
      { lens: 'soundness', severity: 'blocking', file: 'a.ts', line: '5', title: 'npe', detail: 'guard' },
    ]
    const { user } = synthesisTask.buildPrompt({ ctx, raw })
    expect(user).toContain('review lead')
    expect(user).toContain('npe')
    expect(user).toContain('[soundness/blocking]')
    expect(user).toContain('+ retry()')
  })
})
