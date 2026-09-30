import { describe, it, expect } from 'vitest'
import { makeOverviewTask, parseOverviewText, OVERVIEW_INSTRUCTIONS } from '../overview-task'
import type { OverviewContext } from '../../github/pr-overview-context'

const ctx: OverviewContext = {
  pr: {
    owner: 'acme', repo: 'ui', number: 7, url: 'https://github.com/acme/ui/pull/7', title: 'Add widget', author: 'a',
    updatedAt: 'd', headSha: 'sha1', additions: 5, deletions: 1, changedFiles: 1, baseRefName: 'main',
    headRefName: 'add-widget', ci: 'green', ciFailing: [], reviewers: [], approvedByOther: false,
    body: 'implements the widget', diff: 'diff --git a/x.ts b/x.ts\n+code',
  },
  handle: 'pago', defaultBranch: 'main', isDraft: false, commits: ['Add widget'], foreignCommits: 0, issues: [],
  discussion: [], changeset: { files: [] }, keyFiles: [], guides: [], triage: [], deep: [], unavailable: [],
}

describe('makeOverviewTask', () => {
  it('asks for the final answer as text, not scanned JSON', () => {
    expect(makeOverviewTask().output).toBe('text')
  })

  it('embeds the instructions, the fixed-section contract and the input', () => {
    const { user } = makeOverviewTask().buildPrompt(ctx)
    expect(user).toContain(OVERVIEW_INSTRUCTIONS)
    for (const h of ['## What changed', '## Why', '## Impact', '## Look into']) expect(user).toContain(h)
    expect(user).toContain('no title, no preamble, no metadata line')
    expect(user).toContain('<diff>\ndiff --git a/x.ts b/x.ts\n+code\n</diff>')
    expect(user).toContain('implements the widget')
  })

  it('an override replaces only the instructions — the headings, citation form and input stay', () => {
    const { user } = makeOverviewTask('Write it like a haiku.').buildPrompt(ctx)
    expect(user).toContain('Write it like a haiku.')
    expect(user).not.toContain("You are writing a reviewer's briefing")
    expect(user).toContain('## Look into')
    expect(user).toContain('`path:line` or `path:start-end`')
    expect(user).toContain('<diff>')
  })

  it('yields the raw answer whatever its structure, and nothing for an empty one', () => {
    expect(parseOverviewText('  Just prose, no headings.\n')).toBe('Just prose, no headings.')
    expect(parseOverviewText('   ')).toBeNull()
    expect(parseOverviewText({ not: 'text' })).toBeNull()
  })
})
