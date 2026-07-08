import { describe, it, expect } from 'vitest'
import { parseTriage, triageTask } from '../triage-task'
import type { PrContext } from '../../../shared/screenprs'

describe('parseTriage', () => {
  it('accepts a well-formed judgment and keeps only valid findings', () => {
    const r = parseTriage({
      impact: 'high',
      findings: [
        { label: 'issue', file: 'a.ts', line: '12-18', title: 'off-by-one' },
        { label: 'praise', file: 'a.ts', title: 'nice' }, // dropped: triage ignores praise
        { label: 'suggestion', file: '', title: 'x' }, // dropped: no file
        { label: 'question', file: 'b.ts', line: 20, title: 'why?' }, // numeric line coerced
      ],
    })
    expect(r?.impact).toBe('high')
    expect(r?.findings).toEqual([
      { label: 'issue', file: 'a.ts', line: '12-18', title: 'off-by-one' },
      { label: 'question', file: 'b.ts', line: '20', title: 'why?' },
    ])
  })

  it('accepts an empty clean result', () => {
    expect(parseTriage({ impact: 'low', findings: [] })).toEqual({ impact: 'low', findings: [] })
  })

  it('rejects malformed input', () => {
    expect(parseTriage(null)).toBeNull()
    expect(parseTriage({ impact: 'huge', findings: [] })).toBeNull()
    expect(parseTriage({ impact: 'low' })).toBeNull() // findings not an array
    expect(parseTriage('nope')).toBeNull()
  })
})

describe('triageTask', () => {
  const ctx: PrContext = {
    owner: 'ivx', repo: 'ui', number: 1, url: 'u', title: 'Add widget', author: 'a', updatedAt: 'd',
    headSha: 'sha1', additions: 5, deletions: 1, changedFiles: 1, baseRefName: 'main',
    ci: 'green', ciFailing: [], reviewers: [], approvedByOther: false,
    body: 'implements the widget', diff: 'diff --git a/x b/x\n+code',
  }

  it('buildContext is identity (context is pre-gathered)', async () => {
    expect(await triageTask.buildContext(ctx)).toBe(ctx)
  })

  it('embeds the diff, title, and description in the prompt', () => {
    const { user } = triageTask.buildPrompt(ctx)
    expect(user).toContain('Add widget')
    expect(user).toContain('implements the widget')
    expect(user).toContain('+code')
    expect(user).toContain('EXACTLY ONE JSON object')
  })
})
