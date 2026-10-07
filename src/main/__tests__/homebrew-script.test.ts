import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { UPGRADE_SCRIPT } from '../homebrew'

/**
 * Runs the real upgrade helper against stub `brew` and `open` executables.
 *
 * The script is the one part of the update path with no type checking and no
 * chance of a second attempt: it executes while the app is gone, and a mistake
 * leaves the user with a half-replaced bundle. So it gets exercised for real.
 */

const run = promisify(execFile)

let dir: string
let script: string
let resultFile: string
let bundle: string
let binDir: string
/** The process group of a detached helper, killed whatever the test's outcome. */
let group: number | undefined

/** A stub on PATH, so the script's bare `open` resolves to us. */
function stub(name: string, body: string): string {
  const path = join(binDir, name)
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  return path
}

function startScript(
  pid: number,
  brew: string,
  version = '9.9.9',
  env: Record<string, string> = {},
  options: Pick<SpawnOptions, 'detached' | 'stdio'> = {}
): ChildProcess {
  return spawn(
    '/bin/sh',
    [script, String(pid), brew, 'pago/simpleedit/simpleedit', resultFile, bundle, 'com.simpleedit.app', version],
    {
      ...options,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        // Half-seconds. Keeps the "app never quit" case from taking a real
        // minute; the production default is 120.
        SIMPLEEDIT_UPGRADE_MAX_WAIT: '4',
        ...env
      }
    }
  )
}

async function runScript(
  pid: number,
  brew: string,
  version = '9.9.9',
  env: Record<string, string> = {}
): Promise<number> {
  const child = startScript(pid, brew, version, env)
  return new Promise((resolve) => child.on('exit', (code) => resolve(code ?? -1)))
}

function result(): { ok: boolean; stage: string; version: string; detail: string } {
  return JSON.parse(readFileSync(resultFile, 'utf8'))
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'se-brew-'))
  binDir = join(dir, 'bin')
  bundle = join(dir, 'SimpleEdit.app')
  mkdirSync(binDir, { recursive: true })
  mkdirSync(join(bundle, 'Contents', 'MacOS'), { recursive: true })
  script = join(dir, 'upgrade.sh')
  resultFile = join(dir, 'result.json')
  writeFileSync(script, UPGRADE_SCRIPT, { mode: 0o700 })
  stub('open', 'echo "open $*" >> "$0.calls"; exit 0')
})

afterEach(() => {
  // Here rather than in the test, so a helper that never exits is killed too.
  if (group !== undefined) {
    try {
      process.kill(-group, 'SIGKILL')
    } catch {
      // ESRCH: nothing left, which is the passing case.
    }
    group = undefined
  }
  rmSync(dir, { recursive: true, force: true })
})

/** A pid that is definitely gone, so the wait loop falls straight through. */
async function deadPid(): Promise<number> {
  const child = spawn('/bin/sh', ['-c', 'exit 0'])
  await new Promise((resolve) => child.on('exit', resolve))
  return child.pid!
}

describe('the detached Homebrew upgrade helper', () => {
  it('is valid POSIX shell', async () => {
    await expect(run('/bin/sh', ['-n', script])).resolves.toBeDefined()
  })

  it('upgrades and relaunches once the app is gone', async () => {
    const brew = stub('fake-brew', 'echo "brew $*"; exit 0')

    const code = await runScript(await deadPid(), brew)

    expect(code).toBe(0)
    expect(result()).toMatchObject({ ok: true, stage: 'done', version: '9.9.9' })
    expect(readFileSync(join(binDir, 'open.calls'), 'utf8')).toContain(bundle)
  })

  // The user quit expecting to come back; Homebrew restores its backup on a
  // failed upgrade, so there should still be an app to open.
  it('records the failure but still relaunches when brew fails', async () => {
    const brew = stub('fake-brew', 'echo "boom" >&2; exit 17')

    const code = await runScript(await deadPid(), brew)

    expect(code).toBe(0)
    expect(result()).toMatchObject({ ok: false, stage: 'upgrade' })
    expect(result().detail).toContain('17')
    expect(existsSync(join(binDir, 'open.calls'))).toBe(true)
  })

  // The whole reason the helper is detached: it must never run brew while an
  // instance is live, or Homebrew replaces the bundle underneath it.
  it('refuses to upgrade while the app is still running', async () => {
    const brew = stub('fake-brew', 'echo "SHOULD NOT RUN" > "$0.ran"; exit 0')
    const alive = spawn('/bin/sh', ['-c', 'sleep 30'])

    const code = await runScript(alive.pid!, brew)
    alive.kill('SIGKILL')

    expect(code).toBe(1)
    expect(result()).toMatchObject({ ok: false, stage: 'wait' })
    expect(existsSync(join(binDir, 'fake-brew.ran'))).toBe(false)
  })

  // `pgrep` exits 1 for "nothing matched" but 2 for a pattern it could not
  // compile and 127 if it is not on PATH. Reading those as "nothing matched" runs
  // brew without ever having checked — the one thing the guard is here to stop.
  it('refuses to upgrade when the running-instance check itself fails', async () => {
    const brew = stub('fake-brew', 'echo "SHOULD NOT RUN" > "$0.ran"; exit 0')
    stub('pgrep', 'echo "pgrep: bad pattern" >&2; exit 2')

    const code = await runScript(await deadPid(), brew)

    expect(code).toBe(1)
    expect(result()).toMatchObject({ ok: false, stage: 'guard' })
    expect(existsSync(join(binDir, 'fake-brew.ran'))).toBe(false)
  })

  // A relaunch between the quit and the upgrade is the subtle version of the
  // same hazard, and `kill -0` on the old pid cannot see it.
  it('aborts if another instance appeared after the first one exited', async () => {
    const brew = stub('fake-brew', 'echo "SHOULD NOT RUN" > "$0.ran"; exit 0')
    // Stand in for a reopened instance by running something at the bundle's real
    // executable path — that is exactly the command line the guard greps for.
    // (Spawning it directly rather than via `exec -a`, which dash lacks, so this
    // works on the Linux CI runner as well as macOS.)
    const exe = join(bundle, 'Contents', 'MacOS', 'SimpleEdit')
    writeFileSync(exe, '#!/bin/sh\nsleep 30\n', { mode: 0o755 })
    const impostor = spawn(exe)
    await new Promise((resolve) => setTimeout(resolve, 300))

    const code = await runScript(await deadPid(), brew)
    impostor.kill('SIGKILL')

    expect(code).toBe(1)
    expect(result()).toMatchObject({ ok: false, stage: 'relaunched' })
    expect(existsSync(join(binDir, 'fake-brew.ran'))).toBe(false)
  })

  it('terminates a brew that never finishes', async () => {
    const brew = stub('fake-brew', 'sleep 60')

    const code = await runScript(await deadPid(), brew, '9.9.9', {
      SIMPLEEDIT_UPGRADE_TIMEOUT: '1'
    })

    expect(code).toBe(0)
    expect(result()).toMatchObject({ ok: false, stage: 'upgrade' })
    expect(existsSync(join(binDir, 'open.calls'))).toBe(true)
  })

  // Production spawns the helper detached, so whatever it leaves behind runs on
  // unseen. Detached here too, it leads its own process group, which everything
  // it starts inherits even once orphaned. By the time 'exit' fires every one of
  // them must already be reaped, so the group must be empty: a probe of it needs
  // no waiting and cannot see anyone else's processes.
  it('leaves nothing running once it exits', async () => {
    const brew = stub('fake-brew', 'exit 0')
    // A real upgrade takes minutes, so the watchdog is always mid-sleep when brew
    // finishes. A stub brew is instant; a long tick restores that.
    stub('sleep', 'exec /bin/sleep 1')
    const child = startScript(await deadPid(), brew, '9.9.9', {}, {
      detached: true,
      stdio: 'ignore'
    })
    group = child.pid!

    expect(await new Promise((resolve) => child.on('exit', resolve))).toBe(0)
    expect(() => process.kill(-group!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
  })
})
