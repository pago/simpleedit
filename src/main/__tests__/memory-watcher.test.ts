import { describe, it, expect, afterAll, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { RemoteClient } from '../client-hub'
import { unwatchAllMemoryDirs, unwatchMemoryDir, watchMemoryDir } from '../memory-watcher'

const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), 'simpleedit-memory-watcher-test-')))

afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }))
afterEach(() => unwatchAllMemoryDirs())

function client(id: number): RemoteClient & { send: ReturnType<typeof vi.fn> } {
  return { id, isDestroyed: () => false, send: vi.fn<(channel: string, data: unknown) => void>() }
}

/** chokidar needs a beat to arm before it reports anything. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 300))

describe('memory-watcher', () => {
  it('reports file adds with their dir and directory adds as structural', async () => {
    const dir = mkdtempSync(join(tmpRoot, 'mem-'))
    const c = client(1)
    watchMemoryDir(c, dir)
    await settle()

    writeFileSync(join(dir, 'a.md'), 'a')
    await vi.waitFor(() => expect(c.send).toHaveBeenCalledWith('memory:changed', { memoryDir: dir, dirs: [dir], structural: false }))

    c.send.mockClear()
    mkdirSync(join(dir, 'sub'))
    await vi.waitFor(() =>
      expect(c.send).toHaveBeenCalledWith('memory:changed', expect.objectContaining({ memoryDir: dir, structural: true })),
    )
  })

  it('reports content-only changes with no dirs', async () => {
    const dir = mkdtempSync(join(tmpRoot, 'mem-'))
    writeFileSync(join(dir, 'a.md'), 'a')
    const c = client(1)
    watchMemoryDir(c, dir)
    await settle()

    writeFileSync(join(dir, 'a.md'), 'changed')
    await vi.waitFor(() => expect(c.send).toHaveBeenCalledWith('memory:changed', { memoryDir: dir, dirs: [], structural: false }))
  })

  it('stops notifying once the last ref is released', async () => {
    const dir = mkdtempSync(join(tmpRoot, 'mem-'))
    const c = client(1)
    watchMemoryDir(c, dir)
    watchMemoryDir(c, dir)
    unwatchMemoryDir(1, dir)
    await settle()
    writeFileSync(join(dir, 'still.md'), 'x')
    await vi.waitFor(() => expect(c.send).toHaveBeenCalled())

    unwatchMemoryDir(1, dir)
    c.send.mockClear()
    writeFileSync(join(dir, 'gone.md'), 'x')
    await new Promise((r) => setTimeout(r, 500))
    expect(c.send).not.toHaveBeenCalled()
  })
})
