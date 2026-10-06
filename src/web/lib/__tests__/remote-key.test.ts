import { describe, it, expect, beforeEach, vi } from 'vitest'
import { pairingProblem, parsePairingLink, resolveKey, settleUrlKey, storeKey } from '../remote-key'

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
    expect(resolveKey('', storage)).toEqual({ key: null, candidate: null })
    expect(resolveKey('?k=not-a-key', storage)).toEqual({ key: null, candidate: null })
  })

  it('adopts the key an install launches with, and keeps it', () => {
    expect(resolveKey(`?k=${A}`, storage)).toEqual({ key: A, candidate: null })
    // A later launch without it — a notification tap opens `/app/`.
    expect(resolveKey('', storage).key).toBe(A)
  })

  // The case the design turns on: iOS repeats the start URL from install on
  // every launch, long after that key went stale. A rescan must win over it.
  it('lets an in-app rescan outrank the start URL that keeps replaying', () => {
    resolveKey(`?k=${A}`, storage)
    storeKey(B, storage)
    expect(resolveKey(`?k=${A}`, storage)).toEqual({ key: B, candidate: null })
    storeKey(C, storage)
    expect(resolveKey(`?k=${A}`, storage)).toEqual({ key: C, candidate: null })
  })

  // An old bookmark, or a link sent to knock this device off its working key,
  // is only a CANDIDATE: it must not replace the stored key on its own say-so.
  it('holds on to a stored key while a new URL key is unconfirmed', () => {
    resolveKey(`?k=${A}`, storage)
    storeKey(B, storage)
    expect(resolveKey(`?k=${C}`, storage)).toEqual({ key: B, candidate: C })
    expect(resolveKey('', storage).key).toBe(B)
  })

  it('does not offer the key it already holds as a candidate', () => {
    storeKey(B, storage)
    expect(resolveKey(`?k=${B}`, storage)).toEqual({ key: B, candidate: null })
  })

  it('still starts when storage refuses every call', () => {
    const broken = memoryStorage()
    broken.getItem = () => { throw new Error('denied') }
    broken.setItem = () => { throw new Error('denied') }
    expect(resolveKey(`?k=${A}`, broken).key).toBe(A)
    expect(resolveKey('', broken).key).toBeNull()
  })
})

describe('settleUrlKey', () => {
  it('adopts a URL key the Mac confirms, and reconnects with it', async () => {
    storeKey(B, storage)
    const onAdopt = vi.fn()
    await settleUrlKey(C, async () => 'current', onAdopt, storage)
    expect(onAdopt).toHaveBeenCalledWith(C)
    expect(resolveKey('', storage).key).toBe(C)
  })

  it('keeps the working key when the URL key is refused, and stops asking', async () => {
    resolveKey(`?k=${A}`, storage)
    storeKey(B, storage)
    const onAdopt = vi.fn()
    const check = vi.fn(async () => 'stale' as const)
    await settleUrlKey(C, check, onAdopt, storage)
    expect(onAdopt).not.toHaveBeenCalled()
    expect(resolveKey(`?k=${C}`, storage)).toEqual({ key: B, candidate: null })
  })

  it('changes nothing when the Mac cannot be asked, and asks again next time', async () => {
    storeKey(B, storage)
    const onAdopt = vi.fn()
    await settleUrlKey(C, async () => { throw new Error('offline') }, onAdopt, storage)
    expect(onAdopt).not.toHaveBeenCalled()
    expect(resolveKey(`?k=${C}`, storage)).toEqual({ key: B, candidate: C })
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
