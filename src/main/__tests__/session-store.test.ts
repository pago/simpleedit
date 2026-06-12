import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { SerializedSession } from '../../shared/ipc-types'

const tmpRoot = mkdtempSync(join(tmpdir(), 'simpleedit-session-test-'))

vi.mock('electron', () => ({
  app: {
    getPath: (_: string) => tmpRoot
  }
}))

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

let saveSession: typeof import('../session-store').saveSession
let loadSession: typeof import('../session-store').loadSession
let clearSession: typeof import('../session-store').clearSession

beforeEach(async () => {
  // Re-import to pick up the mock
  const mod = await import('../session-store')
  saveSession = mod.saveSession
  loadSession = mod.loadSession
  clearSession = mod.clearSession
})

function fixture(repoPath = '/tmp/test-repo.git'): SerializedSession {
  return {
    version: 2,
    repoPath,
    savedAt: '2026-04-27T00:00:00.000Z',
    sessions: [
      {
        kind: 'claude',
        label: 'Claude',
        sessionId: 'sid-1',
        worktreePath: '/tmp/test-repo/main',
        tabs: [{ kind: 'file', id: 'file:/tmp/x.ts', path: '/tmp/x.ts' }],
        activeTabId: 'file:/tmp/x.ts',
        unread: []
      }
    ],
    activeIndex: 0
  }
}

describe('session-store', () => {
  it('round-trips a saved session', () => {
    const payload = fixture()
    saveSession(payload)
    const loaded = loadSession(payload.repoPath)
    expect(loaded).toEqual(payload)
  })

  it('returns null for an unknown repo', () => {
    expect(loadSession('/nonexistent/repo')).toBeNull()
  })

  it('returns null when the version does not match', () => {
    const payload = fixture('/tmp/version-test.git')
    saveSession(payload)
    // Manually corrupt the version
    const corrupted = { ...payload, version: 99 as 2 }
    saveSession(corrupted)
    expect(loadSession(payload.repoPath)).toBeNull()
  })

  it('returns null when the file repoPath does not match the requested repoPath', () => {
    const payload = fixture('/tmp/path-a.git')
    saveSession(payload)
    // Different request path → should not return the file even if hashes coincide
    expect(loadSession('/tmp/path-b.git')).toBeNull()
  })

  it('writes to a different file per repo path', () => {
    const a = fixture('/tmp/repo-a.git')
    const b = fixture('/tmp/repo-b.git')
    saveSession(a)
    saveSession(b)
    expect(loadSession(a.repoPath)?.repoPath).toBe('/tmp/repo-a.git')
    expect(loadSession(b.repoPath)?.repoPath).toBe('/tmp/repo-b.git')
  })

  it('clear removes the saved session', () => {
    const payload = fixture('/tmp/clearable.git')
    saveSession(payload)
    expect(loadSession(payload.repoPath)).not.toBeNull()
    clearSession(payload.repoPath)
    expect(loadSession(payload.repoPath)).toBeNull()
  })

  it('clear is a no-op when the file does not exist', () => {
    expect(() => clearSession('/tmp/nonexistent.git')).not.toThrow()
  })

  it('creates the sessions directory if it does not exist', () => {
    saveSession(fixture('/tmp/dir-test.git'))
    expect(existsSync(join(tmpRoot, 'config', 'sessions'))).toBe(true)
  })
})
