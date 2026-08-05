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
const FP = 'triage-v1'
const DEEP_FP = 'deep-v1'

describe('screenprs-cache', () => {
  it('misses when empty', () => {
    expect(cache.getCached('u1', 'sha1', FP)).toBeUndefined()
  })

  it('round-trips a triage result at a given SHA', () => {
    cache.putTriage('u1', 'sha1', 'the diff', triage, FP)
    const hit = cache.getCached('u1', 'sha1', FP)
    expect(hit?.triage).toEqual(triage)
    expect(hit?.diff).toBe('the diff')
  })

  it('invalidates when the head SHA changes', () => {
    cache.putTriage('u1', 'sha1', 'd', triage, FP)
    expect(cache.getCached('u1', 'sha2', FP)).toBeUndefined() // new push ⇒ miss
    expect(cache.getCached('u1', 'sha1', FP)).toBeDefined()
  })

  it('persists across a reload (new module instance reads the file)', async () => {
    cache.putTriage('u1', 'sha1', 'd', triage, FP)
    vi.resetModules()
    const reloaded = await import('../screenprs-cache')
    expect(reloaded.getCached('u1', 'sha1', FP)?.triage).toEqual(triage)
  })

  it('attaches deep results only when the SHA matches', () => {
    cache.putTriage('u1', 'sha1', 'd', triage, FP)
    cache.putDeep('u1', 'sha1', deep, DEEP_FP)
    expect(cache.getCachedDeep('u1', 'sha1', DEEP_FP)).toEqual(deep)

    // A deep write against a stale SHA is a no-op.
    cache.putDeep('u1', 'sha-old', [{ ...deep[0], title: 'stale' }], DEEP_FP)
    expect(cache.getCachedDeep('u1', 'sha1', DEEP_FP)).toEqual(deep)
  })

  it('misses legacy and mismatched analysis fingerprints', () => {
    cache.putTriage('u1', 'sha1', 'd', triage, FP)
    expect(cache.getCached('u1', 'sha1', 'other')).toBeUndefined()
    cache.putDeep('u1', 'sha1', deep, DEEP_FP)
    expect(cache.getCachedDeep('u1', 'sha1', 'other')).toBeUndefined()
  })

  it('prunes entries older than 30 days', () => {
    const now = Date.parse('2026-07-08T00:00:00Z')
    const fresh = { headSha: 's', diff: '', triage, at: '2026-07-07T00:00:00Z' }
    const stale = { headSha: 's', diff: '', triage, at: '2026-05-01T00:00:00Z' }
    const pruned = cache.prune({ fresh, stale }, now)
    expect(Object.keys(pruned)).toEqual(['fresh'])
  })
})
