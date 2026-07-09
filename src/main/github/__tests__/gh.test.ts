import { describe, it, expect } from 'vitest'
import { parseSearch, parseChecks, assembleMeta } from '../gh'
import type { PrRef } from '../../../shared/screenprs'

describe('parseSearch', () => {
  it('extracts owner/repo/author from the search JSON', () => {
    const json = JSON.stringify([
      {
        number: 42,
        title: 'Fix thing',
        url: 'https://github.com/acme/ui-pack/pull/42',
        updatedAt: '2026-07-05T10:00:00Z',
        author: { login: 'alice' },
        repository: { name: 'ui-pack', nameWithOwner: 'acme/ui-pack' },
      },
    ])
    const [pr] = parseSearch(json)
    expect(pr).toMatchObject({ owner: 'acme', repo: 'ui-pack', number: 42, author: 'alice' })
  })
  it('tolerates missing author/repository', () => {
    const [pr] = parseSearch(JSON.stringify([{ number: 1, title: 't', url: 'u', updatedAt: 'd' }]))
    expect(pr.author).toBe('unknown')
    expect(pr.owner).toBe('')
  })
})

describe('parseChecks', () => {
  it('treats no checks as green', () => {
    expect(parseChecks('[]')).toEqual({ ci: 'green', ciFailing: [] })
    expect(parseChecks('')).toEqual({ ci: 'green', ciFailing: [] })
  })
  it('reports failing checks by name', () => {
    const json = JSON.stringify([
      { name: 'unit', state: 'SUCCESS', bucket: 'pass' },
      { name: 'e2e', state: 'FAILURE', bucket: 'fail' },
    ])
    expect(parseChecks(json)).toEqual({ ci: 'failing', ciFailing: ['e2e'] })
  })
  it('reports pending when nothing failed but something is in progress', () => {
    const json = JSON.stringify([{ name: 'build', state: 'IN_PROGRESS', bucket: 'pending' }])
    expect(parseChecks(json)).toEqual({ ci: 'pending', ciFailing: [] })
  })
})

describe('assembleMeta', () => {
  const ref: PrRef = {
    owner: 'acme', repo: 'ui-pack', number: 7, url: 'u', title: 't', author: 'bob', updatedAt: 'd',
  }
  it('merges view + checks, captures head SHA, and computes approvedByOther', () => {
    const view = JSON.stringify({
      additions: 100, deletions: 5, changedFiles: 3, baseRefName: 'main', headRefOid: 'abc123', body: 'desc',
      latestReviews: [
        { author: { login: 'carol' }, state: 'APPROVED' },
        { author: { login: 'bob' }, state: 'COMMENTED' },
      ],
    })
    const meta = assembleMeta(ref, view, '[]', 'pago')
    expect(meta.additions).toBe(100)
    expect(meta.headSha).toBe('abc123')
    expect(meta.approvedByOther).toBe(true) // carol approved, and carol !== pago
    expect(meta.reviewers).toEqual([
      { login: 'carol', state: 'approved' },
      { login: 'bob', state: 'commented' },
    ])
  })
  it('does not count the current user’s own approval as approvedByOther', () => {
    const view = JSON.stringify({
      additions: 1, deletions: 0, changedFiles: 1, baseRefName: 'main', headRefOid: 'x', body: '',
      latestReviews: [{ author: { login: 'pago' }, state: 'APPROVED' }],
    })
    expect(assembleMeta(ref, view, '[]', 'pago').approvedByOther).toBe(false)
  })
  it('captures headRefName for stacked-PR detection (falls back to empty)', () => {
    const withHead = JSON.stringify({
      additions: 1, deletions: 0, changedFiles: 1, baseRefName: 'feat/base', headRefName: 'feat/child',
      headRefOid: 'x', body: '', latestReviews: [],
    })
    expect(assembleMeta(ref, withHead, '[]', 'pago').headRefName).toBe('feat/child')
    const noHead = JSON.stringify({
      additions: 1, deletions: 0, changedFiles: 1, baseRefName: 'main', headRefOid: 'x', body: '', latestReviews: [],
    })
    expect(assembleMeta(ref, noHead, '[]', 'pago').headRefName).toBe('')
  })
})
