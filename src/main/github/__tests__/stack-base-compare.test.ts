import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../gh', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../gh')>()),
  runGh: vi.fn(),
}))

import { runGh } from '../gh'
import { compareHeads, parseCompare, parseCompareStatus } from '../stack-base'

const URL = 'https://github.com/acme/app/pull/12'
const commit = (parents: number) => ({ sha: 'x', parents: Array.from({ length: parents }, () => ({ sha: 'p' })) })

describe('parseCompareStatus', () => {
  it.each(['ahead', 'identical', 'behind', 'diverged'] as const)('reads %s', (status) => {
    expect(parseCompareStatus(JSON.stringify({ status, ahead_by: 2, behind_by: 1, commits: [] }))).toEqual({
      status,
      aheadBy: 2,
      behindBy: 1,
      mergeCommit: false,
    })
  })

  it('notices a merge commit among the new commits', () => {
    expect(parseCompareStatus(JSON.stringify({ status: 'ahead', ahead_by: 2, commits: [commit(1), commit(2)] })).mergeCommit).toBe(true)
  })

  it('refuses an unknown status and treats bad counts as zero', () => {
    expect(() => parseCompareStatus(JSON.stringify({ status: 'sideways' }))).toThrow()
    expect(() => parseCompareStatus('[]')).toThrow()
    expect(parseCompareStatus(JSON.stringify({ status: 'ahead', ahead_by: -3, behind_by: '1' }))).toMatchObject({ aheadBy: 0, behindBy: 0 })
  })

  it('leaves the base compare parser as it was', () => {
    expect(parseCompare(JSON.stringify({ behind_by: 3, commits: [] }))).toEqual({ behindBy: 3, commits: [] })
  })
})

describe('compareHeads', () => {
  beforeEach(() => vi.mocked(runGh).mockReset())

  it('asks GitHub for from...to in the PR’s repo', async () => {
    vi.mocked(runGh).mockResolvedValue(JSON.stringify({ status: 'ahead', ahead_by: 1, commits: [commit(1)] }))
    await expect(compareHeads(URL, 'aaa', 'bbb')).resolves.toMatchObject({ status: 'ahead', aheadBy: 1 })
    expect(vi.mocked(runGh).mock.calls[0]![0]).toEqual(['api', '--hostname', 'github.com', 'repos/acme/app/compare/aaa...bbb'])
  })

  it('reads a 404 (the old head is gone) as missing and rethrows anything else', async () => {
    vi.mocked(runGh).mockRejectedValueOnce(new Error('gh api exited 1: gh: Not Found (HTTP 404)'))
    await expect(compareHeads(URL, 'aaa', 'bbb')).resolves.toBe('missing')
    vi.mocked(runGh).mockRejectedValueOnce(new Error('gh api exited 1: HTTP 502'))
    await expect(compareHeads(URL, 'aaa', 'bbb')).rejects.toThrow('502')
  })
})
