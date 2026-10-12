import { describe, it, expect, vi } from 'vitest'
import { VersionCheck, type VersionCheckDeps } from '../version-check.svelte'
import { RELOAD_MARKER_KEY } from '../version-reload'

function memoryStorage(): () => Storage {
  const items = new Map<string, string>()
  const storage = {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => { items.set(k, v) },
  } as unknown as Storage
  return () => storage
}

function check(over: Partial<VersionCheckDeps> = {}): { vc: VersionCheck; reload: ReturnType<typeof vi.fn> } {
  const reload = vi.fn()
  const vc = new VersionCheck({
    loaded: '1.0.0+old',
    discards: () => [],
    atRoot: () => true,
    visible: () => true,
    reload,
    storage: memoryStorage(),
    ...over,
  })
  return { vc, reload }
}

describe('VersionCheck', () => {
  it('reloads at once from the list with nothing at risk, and once only', () => {
    const storage = memoryStorage()
    const { vc, reload } = check({ storage })
    vc.hello('1.1.0+new')
    expect(reload).toHaveBeenCalledOnce()
    expect(storage().getItem(RELOAD_MARKER_KEY)).toBe('1.1.0+new')

    const after = check({ storage })
    after.vc.hello('1.1.0+new')
    expect(after.reload).not.toHaveBeenCalled()
    expect(after.vc.newer).toBe('1.1.0+new')
  })

  it('offers instead while the reader is in a session, and a tap reloads without asking', () => {
    const { vc, reload } = check({ atRoot: () => false })
    vc.hello('1.1.0+new')
    expect(reload).not.toHaveBeenCalled()
    expect(vc.newer).toBe('1.1.0+new')
    vc.request()
    expect(vc.confirming).toBe(false)
    expect(reload).toHaveBeenCalledOnce()
  })

  it('asks before a reload that would throw something away', () => {
    const { vc, reload } = check({ discards: () => ['your reply in a thread'] })
    vc.hello('1.1.0+new')
    vc.request()
    expect(vc.confirming).toBe(true)
    vc.keep()
    expect(reload).not.toHaveBeenCalled()
    vc.request()
    vc.discard()
    expect(reload).toHaveBeenCalledOnce()
  })

  it('reloads on coming back on screen only when it is safe there too', () => {
    let visible = false
    let atRoot = false
    const { vc, reload } = check({ visible: () => visible, atRoot: () => atRoot })
    vc.hello('1.1.0+new')
    visible = true
    vc.shown()
    expect(reload).not.toHaveBeenCalled()
    atRoot = true
    vc.shown()
    expect(reload).toHaveBeenCalledOnce()
  })

  it('drops the banner and its confirm when a later hello matches', () => {
    const { vc } = check({ discards: () => ['a recording'] })
    vc.hello('1.1.0+new')
    vc.request()
    expect(vc.confirming).toBe(true)
    vc.hello('1.0.0+old')
    expect(vc.newer).toBeNull()
    expect(vc.confirming).toBe(false)
  })
})
