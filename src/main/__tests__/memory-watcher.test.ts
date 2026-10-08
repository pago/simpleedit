import { describe, it, expect, afterAll, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { RemoteClient } from '../client-hub'
import { memoryWatchReady, unwatchAllMemoryDirs, unwatchMemoryDir, watchMemoryDir } from '../memory-watcher'

const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), 'simpleedit-memory-watcher-test-')))

afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }))
afterEach(() => unwatchAllMemoryDirs())

function client(id: number): RemoteClient & { send: ReturnType<typeof vi.fn> } {
  return { id, isDestroyed: () => false, send: vi.fn<(channel: string, data: unknown) => void>() }
}

const WAIT = { timeout: 5000 }
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Wait until `c` provably hears about changes in `dir`, then clear its calls.
 * chokidar's `ready` only means its scan is done: on macOS the FSEvents
 * stream behind `fs.watch` starts asynchronously, and under load a change made
 * right after `ready` can be lost. So poke a probe file until an event lands,
 * then wait out the debounce until no more arrive.
 */
async function armed(dir: string, c: ReturnType<typeof client>): Promise<void> {
  await memoryWatchReady(dir)
  let n = 0
  await vi.waitFor(
    () => {
      writeFileSync(join(dir, '.probe'), String(n++))
      expect(c.send).toHaveBeenCalled()
    },
    { timeout: 10_000, interval: 250 },
  )
  for (let calls = -1; calls !== c.send.mock.calls.length; ) {
    calls = c.send.mock.calls.length
    await sleep(500)
  }
  c.send.mockClear()
}

describe('memory-watcher', { timeout: 30_000 }, () => {
  it('reports file adds with their dir and directory adds as structural', async () => {
    const dir = mkdtempSync(join(tmpRoot, 'mem-'))
    const c = client(1)
    watchMemoryDir(c, dir)
    await armed(dir, c)

    writeFileSync(join(dir, 'a.md'), 'a')
    await vi.waitFor(() => expect(c.send).toHaveBeenCalledWith('memory:changed', { memoryDir: dir, dirs: [dir], structural: false }), WAIT)

    c.send.mockClear()
    mkdirSync(join(dir, 'sub'))
    await vi.waitFor(() =>
      expect(c.send).toHaveBeenCalledWith('memory:changed', expect.objectContaining({ memoryDir: dir, structural: true })),
      WAIT,
    )
  })

  it('reports content-only changes with no dirs', async () => {
    const dir = mkdtempSync(join(tmpRoot, 'mem-'))
    writeFileSync(join(dir, 'a.md'), 'a')
    const c = client(1)
    watchMemoryDir(c, dir)
    await armed(dir, c)

    writeFileSync(join(dir, 'a.md'), 'changed')
    await vi.waitFor(() => expect(c.send).toHaveBeenCalledWith('memory:changed', { memoryDir: dir, dirs: [], structural: false }), WAIT)
  })

  it('ignores changes inside .git', async () => {
    const dir = mkdtempSync(join(tmpRoot, 'mem-'))
    mkdirSync(join(dir, '.git'))
    const c = client(1)
    watchMemoryDir(c, dir)
    await armed(dir, c)

    writeFileSync(join(dir, '.git', 'index'), 'x')
    mkdirSync(join(dir, '.git', 'objects'))
    await new Promise((r) => setTimeout(r, 500))
    expect(c.send).not.toHaveBeenCalled()
  })

  it('does not watch a dir that does not exist, and watches it once it does', async () => {
    const dir = join(tmpRoot, 'not-yet')
    const c = client(1)
    expect(watchMemoryDir(c, dir)).toBe(false)

    mkdirSync(dir)
    expect(watchMemoryDir(c, dir)).toBe(true)
    await armed(dir, c)
    writeFileSync(join(dir, 'a.md'), 'a')
    await vi.waitFor(() => expect(c.send).toHaveBeenCalledWith('memory:changed', { memoryDir: dir, dirs: [dir], structural: false }), WAIT)
  })

  it('reports its own removal as structural, then starts afresh on the next watch', async () => {
    const dir = mkdtempSync(join(tmpRoot, 'mem-'))
    writeFileSync(join(dir, 'a.md'), 'a')
    const c = client(1)
    watchMemoryDir(c, dir)
    await armed(dir, c)

    rmSync(dir, { recursive: true, force: true })
    await vi.waitFor(() =>
      expect(c.send).toHaveBeenCalledWith(
        'memory:changed',
        expect.objectContaining({ memoryDir: dir, structural: true, watchEnded: true }),
      ),
      WAIT,
    )

    mkdirSync(dir)
    expect(watchMemoryDir(c, dir)).toBe(true)
    await armed(dir, c)
    c.send.mockClear()
    writeFileSync(join(dir, 'b.md'), 'b')
    await vi.waitFor(() => expect(c.send).toHaveBeenCalledWith('memory:changed', { memoryDir: dir, dirs: [dir], structural: false }), WAIT)
  })

  it('stops notifying once the last ref is released', async () => {
    const dir = mkdtempSync(join(tmpRoot, 'mem-'))
    const c = client(1)
    watchMemoryDir(c, dir)
    watchMemoryDir(c, dir)
    unwatchMemoryDir(1, dir)
    await armed(dir, c)
    writeFileSync(join(dir, 'still.md'), 'x')
    await vi.waitFor(() => expect(c.send).toHaveBeenCalled(), WAIT)

    unwatchMemoryDir(1, dir)
    c.send.mockClear()
    writeFileSync(join(dir, 'gone.md'), 'x')
    await new Promise((r) => setTimeout(r, 500))
    expect(c.send).not.toHaveBeenCalled()
  })

  it('ends every subscriber\'s watch when a re-watch finds the dir gone first', async () => {
    const dir = mkdtempSync(join(tmpRoot, 'mem-'))
    const a = client(1)
    const b = client(2)
    watchMemoryDir(a, dir)
    watchMemoryDir(b, dir)
    await memoryWatchReady(dir)

    // Synchronous with the removal, so this check beats chokidar's unlinkDir.
    rmSync(dir, { recursive: true, force: true })
    expect(watchMemoryDir(a, dir)).toBe(false)

    const ended = expect.objectContaining({ memoryDir: dir, structural: true, watchEnded: true })
    expect(a.send).toHaveBeenCalledWith('memory:changed', ended)
    expect(b.send).toHaveBeenCalledWith('memory:changed', ended)
  })
})
