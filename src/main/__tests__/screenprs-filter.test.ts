import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const tmpRoot = mkdtempSync(join(tmpdir(), 'se-filter-test-'))
vi.mock('electron', () => ({ app: { getPath: () => tmpRoot } }))
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }))

const FILE = join(tmpRoot, 'config', 'screenprs-filter.json')
let filter: typeof import('../screenprs-filter')

beforeEach(async () => {
  vi.resetModules()
  rmSync(FILE, { force: true })
  filter = await import('../screenprs-filter')
})

describe('screenprs-filter', () => {
  it('starts at every org, 30 days', () => {
    expect(filter.loadFilter().filter).toEqual({ owner: '', cutoffDays: 30 })
  })

  it('persists a change and reports it with a newer revision', () => {
    const before = filter.loadFilter().rev
    const res = filter.setFilter({ owner: 'acme', cutoffDays: 7 })
    expect(res).toMatchObject({ filter: { owner: 'acme', cutoffDays: 7 }, changed: true })
    expect(res.rev).toBeGreaterThan(before)
    expect(JSON.parse(readFileSync(FILE, 'utf-8'))).toEqual({ owner: 'acme', cutoffDays: 7 })
  })

  it('does not count setting what is already saved as a change', () => {
    const first = filter.setFilter({ owner: 'acme', cutoffDays: 7 })
    const again = filter.setFilter({ owner: ' acme ', cutoffDays: 7 })
    expect(again).toMatchObject({ changed: false, rev: first.rev })
  })

  it('refuses an invalid filter and keeps what was saved', () => {
    filter.setFilter({ owner: 'acme', cutoffDays: 7 })
    expect(() => filter.setFilter({ owner: '--evil', cutoffDays: 7 })).toThrow(/isn't a GitHub org/)
    expect(filter.loadFilter().filter).toEqual({ owner: 'acme', cutoffDays: 7 })
  })

  it('survives a restart', async () => {
    filter.setFilter({ owner: 'acme', cutoffDays: 90 })
    vi.resetModules()
    const fresh = await import('../screenprs-filter')
    expect(fresh.loadFilter().filter).toEqual({ owner: 'acme', cutoffDays: 90 })
  })

  it('falls back to the default when the file does not hold up', () => {
    mkdirSync(join(tmpRoot, 'config'), { recursive: true })
    writeFileSync(FILE, JSON.stringify({ owner: 'a b', cutoffDays: 1 }))
    filter.resetFilterCache()
    expect(filter.loadFilter().filter).toEqual({ owner: '', cutoffDays: 30 })
  })
})
