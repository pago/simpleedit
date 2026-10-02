import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { PrReviewComment } from '../../shared/screenprs'

const tmpRoot = mkdtempSync(join(tmpdir(), 'se-drafts-test-'))
vi.mock('electron', () => ({ app: { getPath: () => tmpRoot } }))
// Pass-through, so a test can make one write fail and see what survives it.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync), renameSync: vi.fn(actual.renameSync) }
})
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }))

const U1 = 'https://github.com/acme/app/pull/1'
const U2 = 'https://github.com/acme/app/pull/2'
const U3 = 'https://github.com/acme/app/pull/3'
const FILE = join(tmpRoot, 'config', 'screenprs-drafts.json')
let drafts: typeof import('../screenprs-drafts')

beforeEach(async () => {
  vi.resetModules()
  vi.mocked(writeFileSync).mockClear()
  rmSync(FILE, { force: true })
  drafts = await import('../screenprs-drafts')
})

const comment = (over: Partial<PrReviewComment> = {}): PrReviewComment => ({
  id: 'c1', source: 'you', file: 'a.ts', line: '5', text: 'why?', ...over,
})
const onDisk = (): Record<string, { draft: unknown; at: string }> => JSON.parse(readFileSync(FILE, 'utf-8'))

describe('screenprs-drafts', () => {
  it('starts empty', () => {
    expect(drafts.loadDrafts().drafts).toEqual({})
  })

  it('applies an op, persists it, and reports the change with a newer revision', () => {
    const before = drafts.loadDrafts().rev
    const res = drafts.applyOp(U1, { kind: 'add-comment', comment: comment() })
    expect(res.changed).toBe(true)
    expect(res.rev).toBeGreaterThan(before)
    expect(res.draft?.comments).toEqual([comment()])
    expect(onDisk()[U1].draft).toEqual(res.draft)
  })

  it('survives a reload — a new module instance reads the file', async () => {
    drafts.applyOp(U1, { kind: 'set-summary', summary: 'LGTM' })
    vi.resetModules()
    const fresh = await import('../screenprs-drafts')
    expect(fresh.loadDrafts().drafts[U1].summary).toBe('LGTM')
  })

  it('reports a no-op as unchanged and does not write', () => {
    drafts.applyOp(U1, { kind: 'add-comment', comment: comment() })
    vi.mocked(writeFileSync).mockClear()
    const res = drafts.applyOp(U1, { kind: 'add-comment', comment: comment({ id: 'c2' }) })
    expect(res.changed).toBe(false)
    expect(writeFileSync).not.toHaveBeenCalled()
  })

  it('deletes a draft that becomes empty instead of storing it', () => {
    drafts.applyOp(U1, { kind: 'add-comment', comment: comment() })
    const res = drafts.applyOp(U1, { kind: 'remove-comment', id: 'c1' })
    expect(res).toMatchObject({ draft: null, changed: true })
    expect(onDisk()).toEqual({})
    expect(drafts.loadDrafts().drafts).toEqual({})
  })

  it('clears a draft', () => {
    drafts.applyOp(U1, { kind: 'set-verdict', verdict: 'comment' })
    expect(drafts.applyOp(U1, { kind: 'clear' })).toMatchObject({ draft: null, changed: true })
    expect(drafts.applyOp(U1, { kind: 'clear' }).changed).toBe(false)
  })

  it('writes through a temp file and renames it into place', () => {
    drafts.applyOp(U1, { kind: 'set-summary', summary: 'x' })
    expect(vi.mocked(writeFileSync).mock.calls.map(([p]) => p)).toEqual([`${FILE}.tmp`])
    expect(existsSync(`${FILE}.tmp`)).toBe(false)
  })

  it('keeps the previous file and in-memory state when a write fails', () => {
    drafts.applyOp(U1, { kind: 'set-summary', summary: 'kept' })
    vi.mocked(writeFileSync).mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    expect(() => drafts.applyOp(U1, { kind: 'set-summary', summary: 'lost' })).toThrow('disk full')
    expect(onDisk()[U1].draft).toMatchObject({ summary: 'kept' })
    expect(drafts.loadDrafts().drafts[U1].summary).toBe('kept')
  })

  it('prunes drafts untouched for 30 days on load', async () => {
    const DAY = 24 * 60 * 60 * 1000
    const draft = { comments: [], summary: 's', verdict: 'approve' }
    mkdirSync(join(tmpRoot, 'config'), { recursive: true })
    writeFileSync(FILE, JSON.stringify({
      [U1]: { draft, at: new Date(Date.now() - 31 * DAY).toISOString() },
      [U2]: { draft, at: new Date(Date.now() - 29 * DAY).toISOString() },
    }))
    vi.resetModules()
    const fresh = await import('../screenprs-drafts')
    expect(Object.keys(fresh.loadDrafts().drafts)).toEqual([U2])
  })

  it('prune is pure and keys off `at`', () => {
    const now = Date.parse('2026-10-02T00:00:00Z')
    const draft = { comments: [], summary: 's', verdict: 'approve' as const }
    const out = drafts.prune({
      a: { draft, at: '2026-09-01T00:00:00Z' },
      b: { draft, at: '2026-09-03T00:00:00Z' },
    }, now)
    expect(Object.keys(out)).toEqual(['b'])
  })

  it('drops a malformed comment on load and keeps the rest of its draft', async () => {
    const at = new Date().toISOString()
    mkdirSync(join(tmpRoot, 'config'), { recursive: true })
    writeFileSync(FILE, JSON.stringify({
      [U1]: { draft: { comments: [comment(), { id: 'c2', source: 'you', file: 'a.ts', text: 42 }, null], summary: 's', verdict: 'nope' }, at },
      [U2]: { draft: 'garbage', at },
      [U3]: null,
      notAUrl: { draft: { comments: [], summary: 'n', verdict: 'approve' }, at },
    }).replace('{', `{"__proto__":{"draft":{"comments":[],"summary":"p","verdict":"approve"},"at":"${at}"},`))
    vi.resetModules()
    const fresh = await import('../screenprs-drafts')
    expect(fresh.loadDrafts().drafts).toEqual({ [U1]: { comments: [comment()], summary: 's', verdict: 'approve' } })
    expect(Object.getPrototypeOf(fresh.loadDrafts().drafts)).toBe(Object.prototype)
  })
})
