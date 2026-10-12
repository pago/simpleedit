import { describe, it, expect, afterEach } from 'vitest'
import { decideReload, loadedBuildId, markReloadFor, readReloadMarker, reloadTarget, RELOAD_MARKER_KEY, type ReloadInputs } from '../version-reload'

const BASE: ReloadInputs = { loaded: '1.0.0+aaa', server: '1.1.0+bbb', visible: true, atRoot: true, atRisk: false, reloadedFor: null }

describe('decideReload', () => {
  it('reloads at once on a mismatch when nothing can be lost and the app is on screen', () => {
    expect(decideReload(BASE)).toBe('reload')
  })

  it('does nothing when the builds match', () => {
    expect(decideReload({ ...BASE, server: BASE.loaded! })).toBe('none')
  })

  it('does nothing when either side has no build id', () => {
    expect(decideReload({ ...BASE, server: undefined })).toBe('none')
    expect(decideReload({ ...BASE, loaded: null })).toBe('none')
  })

  it('asks instead when something would be thrown away', () => {
    expect(decideReload({ ...BASE, atRisk: true })).toBe('prompt')
  })

  it('waits while the app is not on screen', () => {
    expect(decideReload({ ...BASE, visible: false })).toBe('prompt')
  })

  it('asks instead when the reader is somewhere a reload would move them from', () => {
    expect(decideReload({ ...BASE, atRoot: false })).toBe('prompt')
  })

  it('never reloads twice for the same server build', () => {
    expect(decideReload({ ...BASE, reloadedFor: BASE.server! })).toBe('prompt')
    expect(decideReload({ ...BASE, reloadedFor: '1.0.5+ccc' })).toBe('reload')
  })
})

describe('build id and reload marker', () => {
  afterEach(() => {
    document.head.querySelector('meta[name="simpleedit-build"]')?.remove()
    sessionStorage.removeItem(RELOAD_MARKER_KEY)
  })

  it('reads the page\'s own build from its meta tag', () => {
    expect(loadedBuildId(document)).toBeNull()
    const meta = document.createElement('meta')
    meta.name = 'simpleedit-build'
    meta.content = '1.0.0+aaa'
    document.head.append(meta)
    expect(loadedBuildId(document)).toBe('1.0.0+aaa')
  })

  it('remembers the build it reloaded for', () => {
    expect(readReloadMarker()).toBeNull()
    expect(markReloadFor('1.1.0+bbb')).toBe(true)
    expect(readReloadMarker()).toBe('1.1.0+bbb')
  })

  it('reports a marker it could not store, so the caller does not reload blind', () => {
    const broken = (): Storage => { throw new Error('denied') }
    expect(markReloadFor('1.1.0+bbb', broken)).toBe(false)
    expect(readReloadMarker(broken)).toBeNull()
  })
})

describe('reloadTarget', () => {
  const KEY = 'a'.repeat(64)
  const RESCANNED = 'b'.repeat(64)

  it('reloads in place when the URL already carries the key in use', () => {
    expect(reloadTarget(`https://mac.ts.net/app/?k=${KEY}`, KEY)).toBeNull()
    expect(reloadTarget(`https://mac.ts.net/app/?k=${KEY}`, null)).toBeNull()
  })

  it('carries a rescanned key into the reloaded URL, dropping the fragment', () => {
    expect(reloadTarget(`https://mac.ts.net/app/?k=${KEY}#session=t1`, RESCANNED)).toBe(`https://mac.ts.net/app/?k=${RESCANNED}`)
    expect(reloadTarget('https://mac.ts.net/app/', RESCANNED)).toBe(`https://mac.ts.net/app/?k=${RESCANNED}`)
  })
})
