import { render, screen } from '@testing-library/svelte'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import PrDetail from '../PrDetail.svelte'
import type { BaseAnalysis, PrContext } from '../../../../shared/screenprs'

const CONTEXT: PrContext = {
  owner: 'ivx', repo: 'ui-pack', number: 2532, url: 'https://github.com/ivx/ui-pack/pull/2532',
  title: 'Virtualize the Table', author: 'dana', updatedAt: '2026-08-01T00:00:00Z',
  headSha: 'own-2', additions: 1, deletions: 0, changedFiles: 1,
  baseRefName: 'compact-density', headRefName: 'table-virtualization', ci: 'green', ciFailing: [],
  reviewers: [], approvedByOther: false, body: '', diff: '',
}
const POLLUTED: BaseAnalysis = {
  kind: 'polluted', basePr: 2531, foreign: 1, behindBy: 199, isolated: true,
  own: [{ sha: 'own-1', subject: 'Improve Timeline' }, { sha: 'own-2', subject: 'Virtualize rows' }],
}

beforeEach(() => {
  vi.stubGlobal('api', { invoke: vi.fn(async () => []), on: () => () => {} })
})

describe('desktop PR detail — base warning', () => {
  it('warns above the diff when GitHub’s diff carries a lower layer', () => {
    const base = { ...POLLUTED, github: { additions: 900, deletions: 40, changedFiles: 69 } }
    render(PrDetail, { props: { context: { ...CONTEXT, changedFiles: 52, base } } })
    expect(screen.getByTestId('base-warning')).toHaveTextContent(
      "Misleading diff on GitHub: includes 1 commit from #2531 (base rebased, behind by 199). GitHub shows 69 files; this PR's own 2 commits touch 52. Showing only those."
    )
  })

  it('says nothing for a clean stack', () => {
    render(PrDetail, { props: { context: { ...CONTEXT, base: { kind: 'clean' } } } })
    expect(screen.queryByTestId('base-warning')).toBeNull()
  })
})
