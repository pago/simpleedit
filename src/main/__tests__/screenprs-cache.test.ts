import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { TriageResult, DeepFinding } from '../../shared/screenprs'

const tmpRoot = mkdtempSync(join(tmpdir(), 'se-cache-test-'))
vi.mock('electron', () => ({ app: { getPath: () => tmpRoot } }))
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }))

let cache: typeof import('../screenprs-cache')

beforeEach(async () => {
  vi.resetModules()
  try {
    rmSync(join(tmpRoot, 'config', 'screenprs-cache.json'))
  } catch {
    /* first run */
  }
  cache = await import('../screenprs-cache')
})

const triage: TriageResult = { impact: 'high', findings: [{ label: 'issue', file: 'a.ts', title: 'bug' }] }
const deep: DeepFinding[] = [{ lens: 'soundness', severity: 'blocking', file: 'a.ts', title: 'npe', detail: 'guard' }]

describe('screenprs-cache', () => {
  it('misses when empty', () => {
    expect(cache.getCached('u1', 'sha1')).toBeUndefined()
  })

  it('round-trips a triage result at a given SHA', () => {
    cache.putTriage('u1', 'sha1', 'the diff', triage)
    const hit = cache.getCached('u1', 'sha1')
    expect(hit?.triage).toEqual(triage)
    expect(hit?.diff).toBe('the diff')
  })

  it('invalidates when the head SHA changes', () => {
    cache.putTriage('u1', 'sha1', 'd', triage)
    expect(cache.getCached('u1', 'sha2')).toBeUndefined() // new push ⇒ miss
    expect(cache.getCached('u1', 'sha1')).toBeDefined()
  })

  it('persists across a reload (new module instance reads the file)', async () => {
    cache.putTriage('u1', 'sha1', 'd', triage)
    vi.resetModules()
    const reloaded = await import('../screenprs-cache')
    expect(reloaded.getCached('u1', 'sha1')?.triage).toEqual(triage)
  })

  it('attaches deep results only when the SHA matches', () => {
    cache.putTriage('u1', 'sha1', 'd', triage)
    cache.putDeep('u1', 'sha1', deep)
    expect(cache.getCached('u1', 'sha1')?.deep).toEqual(deep)

    // A deep write against a stale SHA is a no-op.
    cache.putDeep('u1', 'sha-old', [{ ...deep[0], title: 'stale' }])
    expect(cache.getCached('u1', 'sha1')?.deep).toEqual(deep)
  })

  it('prunes entries older than 30 days', () => {
    const now = Date.parse('2026-07-08T00:00:00Z')
    const fresh = { headSha: 's', diff: '', triage, at: '2026-07-07T00:00:00Z' }
    const stale = { headSha: 's', diff: '', triage, at: '2026-05-01T00:00:00Z' }
    const pruned = cache.prune({ fresh, stale }, now)
    expect(Object.keys(pruned)).toEqual(['fresh'])
  })
})
