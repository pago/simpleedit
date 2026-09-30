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
const KEY = 'default:main'
const BASE = { key: KEY }

describe('screenprs-cache', () => {
  it('misses when empty', () => {
    expect(cache.getCached('u1', 'sha1', FP, KEY)).toBeUndefined()
  })

  it('round-trips a triage result at a given SHA', () => {
    cache.putTriage('u1', 'sha1', 'the diff', triage, FP, BASE)
    const hit = cache.getCached('u1', 'sha1', FP, KEY)
    expect(hit?.triage).toEqual(triage)
    expect(hit?.diff).toBe('the diff')
  })

  it('invalidates when the head SHA changes', () => {
    cache.putTriage('u1', 'sha1', 'd', triage, FP, BASE)
    expect(cache.getCached('u1', 'sha2', FP, KEY)).toBeUndefined() // new push ⇒ miss
    expect(cache.getCached('u1', 'sha1', FP, KEY)).toBeDefined()
  })

  it('persists across a reload (new module instance reads the file)', async () => {
    cache.putTriage('u1', 'sha1', 'd', triage, FP, BASE)
    vi.resetModules()
    const reloaded = await import('../screenprs-cache')
    expect(reloaded.getCached('u1', 'sha1', FP, KEY)?.triage).toEqual(triage)
  })

  it('attaches deep results only when the SHA matches', () => {
    cache.putTriage('u1', 'sha1', 'd', triage, FP, BASE)
    cache.putDeep('u1', 'sha1', deep, DEEP_FP)
    expect(cache.getCachedDeep('u1', 'sha1', DEEP_FP)).toEqual(deep)

    // A deep write against a stale SHA is a no-op.
    cache.putDeep('u1', 'sha-old', [{ ...deep[0], title: 'stale' }], DEEP_FP)
    expect(cache.getCachedDeep('u1', 'sha1', DEEP_FP)).toEqual(deep)
  })

  it('misses legacy and mismatched analysis fingerprints', () => {
    cache.putTriage('u1', 'sha1', 'd', triage, FP, BASE)
    expect(cache.getCached('u1', 'sha1', 'other', KEY)).toBeUndefined()
    cache.putDeep('u1', 'sha1', deep, DEEP_FP)
    expect(cache.getCachedDeep('u1', 'sha1', 'other')).toBeUndefined()
  })

  it('misses when the base moves under an unchanged head', () => {
    cache.putTriage('u1', 'sha1', 'polluted diff', triage, FP, { key: 'stacked:base1' })
    expect(cache.getCached('u1', 'sha1', FP, 'stacked:base2')).toBeUndefined()
    expect(cache.getCached('u1', 'sha1', FP, 'stacked:base1')).toBeDefined()
  })

  it('round-trips the base analysis', () => {
    const analysis = { kind: 'polluted' as const, foreign: 1, behindBy: 3, own: [{ sha: 'b', subject: 'mine' }], isolated: true }
    cache.putTriage('u1', 'sha1', 'd', triage, FP, { key: 'stacked:base1', analysis })
    expect(cache.getCached('u1', 'sha1', FP, 'stacked:base1')?.base).toEqual(analysis)
  })

  it('drops the deep result when the base moves', () => {
    cache.putTriage('u1', 'sha1', 'd', triage, FP, { key: 'stacked:base1' })
    cache.putDeep('u1', 'sha1', deep, DEEP_FP)
    cache.putTriage('u1', 'sha1', 'd2', triage, FP, { key: 'stacked:base2' })
    expect(cache.getCachedDeep('u1', 'sha1', DEEP_FP)).toBeUndefined()
  })

  it('serves the cached diff at a head regardless of fingerprint', () => {
    cache.putTriage('u1', 'sha1', 'the diff', triage, FP, BASE)
    expect(cache.getCachedDiff('u1', 'sha1')).toBe('the diff')
    expect(cache.getCachedDiff('u1', 'sha2')).toBeUndefined()
  })

  describe('overview', () => {
    const OV = { text: '## What changed\nA', facts: { draft: false, changeset: 'no' as const }, at: '2026-09-30T00:00:00Z' }
    const OV_FP = 'overview-v1'

    it('attaches only at the same SHA and serves only its own fingerprint', () => {
      cache.putTriage('u1', 'sha1', 'd', triage, FP, BASE)
      cache.putOverview('u1', 'sha-old', OV, OV_FP)
      expect(cache.getCachedOverview('u1', 'sha1', OV_FP)).toBeUndefined()
      cache.putOverview('u1', 'sha1', OV, OV_FP)
      expect(cache.getCachedOverview('u1', 'sha1', OV_FP)).toEqual(OV)
      expect(cache.getCachedOverview('u1', 'sha1', 'edited-override')).toBeUndefined()
      expect(cache.getCachedOverview('u1', 'sha2', OV_FP)).toBeUndefined()
    })

    it('survives a re-screen of the same diff, even under a new triage prompt', () => {
      cache.putTriage('u1', 'sha1', 'd', triage, FP, BASE)
      cache.putOverview('u1', 'sha1', OV, OV_FP)
      cache.putTriage('u1', 'sha1', 'd', triage, 'triage-v2', BASE)
      expect(cache.getCachedOverview('u1', 'sha1', OV_FP)).toEqual(OV)
    })

    it('is dropped when the base moves under an unchanged head', () => {
      cache.putTriage('u1', 'sha1', 'd', triage, FP, { key: 'stacked:base1' })
      cache.putOverview('u1', 'sha1', OV, OV_FP)
      cache.putTriage('u1', 'sha1', 'd2', triage, FP, { key: 'stacked:base2' })
      expect(cache.getCachedOverview('u1', 'sha1', OV_FP)).toBeUndefined()
    })

    it('hands the overview the findings already made at this head', () => {
      cache.putTriage('u1', 'sha1', 'd', triage, FP, BASE)
      cache.putDeep('u1', 'sha1', deep, DEEP_FP)
      expect(cache.getCachedFindings('u1', 'sha1')).toEqual({ triage: triage.findings, deep })
      expect(cache.getCachedFindings('u1', 'sha2')).toEqual({ triage: [], deep: [] })
    })
  })

  it('prunes entries older than 30 days', () => {
    const now = Date.parse('2026-07-08T00:00:00Z')
    const fresh = { headSha: 's', diff: '', triage, at: '2026-07-07T00:00:00Z' }
    const stale = { headSha: 's', diff: '', triage, at: '2026-05-01T00:00:00Z' }
    const pruned = cache.prune({ fresh, stale }, now)
    expect(Object.keys(pruned)).toEqual(['fresh'])
  })
})
