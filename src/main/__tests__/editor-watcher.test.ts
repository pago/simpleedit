import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('electron', () => ({}))

const tmpRoot = mkdtempSync(join(tmpdir(), 'simpleedit-editor-watcher-test-'))

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

function makeWebContents(id: number): { id: number; isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> } {
  return {
    id,
    isDestroyed: () => false,
    send: vi.fn(),
  }
}

let watchEditorFile: typeof import('../editor-watcher').watchEditorFile
let unwatchEditorFile: typeof import('../editor-watcher').unwatchEditorFile
let unwatchAllEditorFilesForWindow: typeof import('../editor-watcher').unwatchAllEditorFilesForWindow

beforeEach(async () => {
  // Fresh module per test to reset internal watcher state
  vi.resetModules()
  const mod = await import('../editor-watcher')
  watchEditorFile = mod.watchEditorFile
  unwatchEditorFile = mod.unwatchEditorFile
  unwatchAllEditorFilesForWindow = mod.unwatchAllEditorFilesForWindow
})

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe('watchEditorFile / unwatchEditorFile', () => {
  it('emits editor:file-changed when a watched file is written', async () => {
    const filePath = join(tmpRoot, `watched-${Math.random().toString(36).slice(2)}.ts`)
    writeFileSync(filePath, 'original')
    const wc = makeWebContents(1)

    watchEditorFile(wc.id, filePath, wc as never)
    // Give chokidar a moment to set up the native FS watch before writing.
    await new Promise((r) => setTimeout(r, 300))

    writeFileSync(filePath, 'updated')
    await waitFor(() => wc.send.mock.calls.length > 0)

    expect(wc.send).toHaveBeenCalledWith('editor:file-changed', { filePath })

    unwatchEditorFile(wc.id, filePath)
  })

  it('stops emitting after unwatch', async () => {
    const filePath = join(tmpRoot, `unwatched-${Math.random().toString(36).slice(2)}.ts`)
    writeFileSync(filePath, 'v1')
    const wc = makeWebContents(2)

    watchEditorFile(wc.id, filePath, wc as never)
    unwatchEditorFile(wc.id, filePath)

    writeFileSync(filePath, 'v2')
    // Give chokidar a moment to fire (it shouldn't)
    await new Promise((r) => setTimeout(r, 300))
    expect(wc.send).not.toHaveBeenCalled()
  })

  it('ref-counts: two watchers on the same file, unwatch first — event still fires for second', async () => {
    const filePath = join(tmpRoot, `refcount-${Math.random().toString(36).slice(2)}.ts`)
    writeFileSync(filePath, 'v1')
    const wc1 = makeWebContents(10)
    const wc2 = makeWebContents(11)

    watchEditorFile(wc1.id, filePath, wc1 as never)
    watchEditorFile(wc2.id, filePath, wc2 as never)
    // Give chokidar time to set up before making changes.
    await new Promise((r) => setTimeout(r, 300))
    unwatchEditorFile(wc1.id, filePath)

    writeFileSync(filePath, 'v2')
    await waitFor(() => wc2.send.mock.calls.length > 0)

    expect(wc1.send).not.toHaveBeenCalled()
    expect(wc2.send).toHaveBeenCalledWith('editor:file-changed', { filePath })

    unwatchEditorFile(wc2.id, filePath)
  })

  it('unwatchAllEditorFilesForWindow tears down all files for that window', async () => {
    const file1 = join(tmpRoot, `multi1-${Math.random().toString(36).slice(2)}.ts`)
    const file2 = join(tmpRoot, `multi2-${Math.random().toString(36).slice(2)}.ts`)
    writeFileSync(file1, 'a')
    writeFileSync(file2, 'a')
    const wc = makeWebContents(20)

    watchEditorFile(wc.id, file1, wc as never)
    watchEditorFile(wc.id, file2, wc as never)
    unwatchAllEditorFilesForWindow(wc.id)

    writeFileSync(file1, 'b')
    writeFileSync(file2, 'b')
    await new Promise((r) => setTimeout(r, 300))
    expect(wc.send).not.toHaveBeenCalled()
  })
})
