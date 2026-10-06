import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { runGh, withGhSignal, GhAbortError } from '../gh'

/**
 * Stopping a screening must take its `gh` children with it. One left running
 * outlives Stop, and at quit the app waits for it.
 *
 * A stub `gh` on PATH records its pid and sleeps, so the test can check the
 * process itself is gone, not only that the promise settled.
 */
let dir: string
let savedPath: string | undefined

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'simpleedit-gh-abort-'))
  fs.writeFileSync(path.join(dir, 'gh'), `#!/usr/bin/env bash\necho $$ > "${dir}/pid"\nexec sleep 30\n`, { mode: 0o755 })
  savedPath = process.env.PATH
  process.env.PATH = `${dir}${path.delimiter}${savedPath ?? ''}`
})

afterAll(() => {
  process.env.PATH = savedPath
  fs.rmSync(dir, { recursive: true, force: true })
})

async function stubPid(): Promise<number> {
  const file = path.join(dir, 'pid')
  for (let i = 0; i < 100; i++) {
    if (fs.existsSync(file)) {
      const pid = Number(fs.readFileSync(file, 'utf8').trim())
      if (pid) return pid
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('the stub gh never started')
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('runGh abort', () => {
  it('kills the gh child when the ambient signal aborts', async () => {
    fs.rmSync(path.join(dir, 'pid'), { force: true })
    const controller = new AbortController()
    const call = withGhSignal(controller.signal, () => runGh(['search', 'prs']))
    const pid = await stubPid()
    expect(alive(pid)).toBe(true)

    controller.abort()

    await expect(call).rejects.toBeInstanceOf(GhAbortError)
    await expect.poll(() => alive(pid)).toBe(false)
  })

  it('never spawns once the signal has aborted', async () => {
    fs.rmSync(path.join(dir, 'pid'), { force: true })
    const controller = new AbortController()
    controller.abort()
    await expect(runGh(['api', 'user'], { signal: controller.signal })).rejects.toBeInstanceOf(GhAbortError)
    expect(fs.existsSync(path.join(dir, 'pid'))).toBe(false)
  })
})
