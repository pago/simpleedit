import { describe, it, expect, beforeEach } from 'vitest'
import { pairingProblem, parsePairingLink, resolveKey, storeKey } from '../remote-key'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const C = 'c'.repeat(64)
const ORIGIN = 'https://mac.tailnet.ts.net'

/** A Storage that is fresh per test, unlike the page's own. */
function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() { return map.size },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => { map.delete(k) },
    setItem: (k, v) => { map.set(k, v) },
  }
}

let storage: Storage
beforeEach(() => { storage = memoryStorage() })

describe('resolveKey', () => {
  it('has nothing to connect with before any pairing', () => {
    expect(resolveKey('', storage)).toBeNull()
    expect(resolveKey('?k=not-a-key', storage)).toBeNull()
  })

  it('adopts the key an install launches with, and keeps it', () => {
    expect(resolveKey(`?k=${A}`, storage)).toBe(A)
    // A later launch without it — a notification tap opens `/app/`.
    expect(resolveKey('', storage)).toBe(A)
  })

  // The case the design turns on: iOS repeats the start URL from install on
  // every launch, long after that key went stale. A rescan must win over it.
  it('lets an in-app rescan outrank the start URL that keeps replaying', () => {
    resolveKey(`?k=${A}`, storage)
    storeKey(B, storage)
    expect(resolveKey(`?k=${A}`, storage)).toBe(B)
    storeKey(C, storage)
    expect(resolveKey(`?k=${A}`, storage)).toBe(C)
  })

  // In Safari, a newly scanned link opens a tab whose URL carries the NEW key.
  it('takes a key from a link it has not seen before', () => {
    resolveKey(`?k=${A}`, storage)
    storeKey(B, storage)
    expect(resolveKey(`?k=${C}`, storage)).toBe(C)
    expect(resolveKey('', storage)).toBe(C)
  })

  it('still starts when storage refuses every call', () => {
    const broken = memoryStorage()
    broken.getItem = () => { throw new Error('denied') }
    broken.setItem = () => { throw new Error('denied') }
    expect(resolveKey(`?k=${A}`, broken)).toBe(A)
    expect(resolveKey('', broken)).toBeNull()
  })
})

describe('parsePairingLink', () => {
  it('reads the key from a pairing link for this address', () => {
    expect(parsePairingLink(`${ORIGIN}/app/?k=${B}`, ORIGIN)).toEqual({ ok: true, key: B })
    expect(parsePairingLink(`  ${ORIGIN}/app/?k=${B}\n`, ORIGIN)).toEqual({ ok: true, key: B })
  })

  // Following it would leave the app's scope for an in-app browser, with its
  // own storage and no push subscription.
  it('refuses a link for another address, and names it', () => {
    const link = parsePairingLink(`http://100.1.2.3:5173/app/?k=${B}`, ORIGIN)
    expect(link).toEqual({ ok: false, reason: 'other-address', origin: 'http://100.1.2.3:5173' })
    if (!link.ok) expect(pairingProblem(link)).toContain('http://100.1.2.3:5173')
  })

  it('refuses what is not a pairing link', () => {
    expect(parsePairingLink('hello', ORIGIN)).toMatchObject({ ok: false, reason: 'not-a-link' })
    expect(parsePairingLink('javascript:alert(1)', ORIGIN)).toMatchObject({ ok: false, reason: 'not-a-link' })
    expect(parsePairingLink(`${ORIGIN}/app/`, ORIGIN)).toMatchObject({ ok: false, reason: 'no-key' })
    expect(parsePairingLink(`${ORIGIN}/app/?k=short`, ORIGIN)).toMatchObject({ ok: false, reason: 'no-key' })
    // The pre-#190 shape: the key in the path.
    expect(parsePairingLink(`${ORIGIN}/${B}/`, ORIGIN)).toMatchObject({ ok: false, reason: 'no-key' })
  })
})
