import { beforeEach, describe, it, expect } from 'vitest'
import {
  AttachSequence,
  PROJECT_STORAGE_KEY,
  attachNotice,
  attachParams,
  loadRememberedProject,
  rememberProject,
  resetPickedProject,
} from '../project'
import type { RemoteProject } from '../../../shared/ipc-types'

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

const A: RemoteProject = { windowId: 1, repoPath: '/p/a.git', name: 'a', focused: false }
const B: RemoteProject = { windowId: 2, repoPath: '/p/b.git', name: 'b', focused: true }

beforeEach(() => resetPickedProject())

describe('the remembered project', () => {
  it('round-trips through storage under its own key', () => {
    const storage = memoryStorage()
    rememberProject(A, storage)
    expect(loadRememberedProject(storage)).toEqual({ repoPath: '/p/a.git', windowId: 1, name: 'a' })
    expect(storage.length).toBe(1)
    expect(storage.key(0)).toBe(PROJECT_STORAGE_KEY)
  })

  it('reads a corrupt or foreign value as nothing remembered', () => {
    const storage = memoryStorage()
    storage.setItem(PROJECT_STORAGE_KEY, '{not json')
    expect(loadRememberedProject(storage)).toBeNull()
    storage.setItem(PROJECT_STORAGE_KEY, JSON.stringify({ windowId: 1 }))
    expect(loadRememberedProject(storage)).toBeNull()
  })

  it('survives storage that throws, keeping the pick for this page', () => {
    const hostile = {
      getItem: () => { throw new Error('blocked') },
      setItem: () => { throw new Error('blocked') },
    } as unknown as Storage
    expect(loadRememberedProject(hostile)).toBeNull()
    expect(() => rememberProject(A, hostile)).not.toThrow()
    expect(loadRememberedProject(hostile)).toEqual({ repoPath: '/p/a.git', windowId: 1, name: 'a' })
  })

  it('names the repo, and the window only as a hint', () => {
    expect(attachParams(null)).toEqual({})
    expect(attachParams({ repoPath: '/p/a.git', windowId: 1, name: 'a' })).toEqual({ repo: '/p/a.git', window: '1' })
    expect(attachParams({ repoPath: '/p/a.git', windowId: 0, name: 'a' })).toEqual({ repo: '/p/a.git' })
  })
})

describe('attachNotice', () => {
  it('stays quiet when the phone landed where it expected', () => {
    expect(attachNotice({ expected: A, previous: A, landed: A, chosen: false })).toBeNull()
    expect(attachNotice({ expected: null, previous: null, landed: A, chosen: false })).toBeNull()
  })

  it('says so when the remembered project is not open and main fell back', () => {
    expect(attachNotice({ expected: A, previous: A, landed: B, chosen: false })).toMatch(
      /a isn't open on the Mac, so this phone is showing b/,
    )
    expect(attachNotice({ expected: A, previous: null, landed: null, chosen: false })).toMatch(/no other window/)
  })

  it('says so when the project changed under a reconnect the user did not ask for', () => {
    expect(attachNotice({ expected: null, previous: A, landed: B, chosen: false })).toBe('Now showing b (was a).')
    expect(attachNotice({ expected: B, previous: A, landed: B, chosen: false })).toBe('Now showing b (was a).')
  })

  it('treats the user\'s own pick as no news', () => {
    expect(attachNotice({ expected: B, previous: A, landed: B, chosen: true })).toBeNull()
  })
})

describe('AttachSequence', () => {
  // Two `hello`s for the same window (a reconnect during the switch) each
  // fetch the project list. The older answer landing last must neither judge
  // nor use up the pick, or the newer one reports the user's own switch.
  it('lets only the latest of two attaches to one window answer a pick', () => {
    const attaches = new AttachSequence()
    attaches.expectPick()
    const older = attaches.begin()
    const newer = attaches.begin()
    expect(attaches.settle(older)).toBeNull()
    expect(attaches.settle(newer)).toEqual({ chosen: true })
  })

  it('consumes a pick once', () => {
    const attaches = new AttachSequence()
    attaches.expectPick()
    expect(attaches.settle(attaches.begin())).toEqual({ chosen: true })
    expect(attaches.settle(attaches.begin())).toEqual({ chosen: false })
  })

  it('keeps the pick for the next attach when one never settles', () => {
    const attaches = new AttachSequence()
    attaches.expectPick()
    attaches.begin() // its list call failed; it never settles
    expect(attaches.settle(attaches.begin())).toEqual({ chosen: true })
  })
})
