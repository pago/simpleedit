import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let focusedWindow: object | null = null
let idleSeconds = 0
const appHandlers = new Map<string, () => void>()

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
    on: (event: string, handler: () => void) => { appHandlers.set(event, handler) },
  },
  BrowserWindow: { getFocusedWindow: () => focusedWindow },
  powerMonitor: { getSystemIdleTime: () => idleSeconds },
}))

import {
  IDLE_THRESHOLD_SECONDS,
  PRESENCE_ENV_VAR,
  isUserPresent,
  presenceFilePath,
  refreshPresence,
  startPresenceTracking,
  stopPresenceTracking,
} from '../presence'

let dir = ''
let marker = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'simpleedit-presence-'))
  marker = join(dir, 'local-client-present')
  process.env.SIMPLEEDIT_E2E_PRESENCE_FILE = marker
  focusedWindow = null
  idleSeconds = 0
  appHandlers.clear()
})

afterEach(() => {
  stopPresenceTracking()
  delete process.env.SIMPLEEDIT_E2E_PRESENCE_FILE
  delete process.env[PRESENCE_ENV_VAR]
  rmSync(dir, { recursive: true, force: true })
})

describe('isUserPresent', () => {
  it('needs a focused window AND recent input', () => {
    expect(isUserPresent(true, 0)).toBe(true)
    expect(isUserPresent(true, IDLE_THRESHOLD_SECONDS - 1)).toBe(true)
  })

  it('is false when no SimpleEdit window is focused', () => {
    expect(isUserPresent(false, 0)).toBe(false)
  })

  /**
   * The failure the plan flags in Claude Code's own check, and the reason the
   * idle half exists: a window left focused on a terminal looks present
   * forever, so you walk away and nothing ever buzzes.
   */
  it('is false for a window left focused while you went for a run', () => {
    expect(isUserPresent(true, IDLE_THRESHOLD_SECONDS)).toBe(false)
    expect(isUserPresent(true, 3600)).toBe(false)
  })
})

describe('the marker file', () => {
  it('appears when you are here and vanishes when you are not', () => {
    startPresenceTracking()
    expect(existsSync(marker)).toBe(false)

    focusedWindow = {}
    idleSeconds = 5
    refreshPresence()
    expect(existsSync(marker)).toBe(true)

    idleSeconds = IDLE_THRESHOLD_SECONDS + 1
    refreshPresence()
    expect(existsSync(marker)).toBe(false)
  })

  it('follows the focus events the app emits', () => {
    startPresenceTracking()
    focusedWindow = {}
    appHandlers.get('browser-window-focus')?.()
    expect(existsSync(marker)).toBe(true)

    focusedWindow = null
    appHandlers.get('browser-window-blur')?.()
    expect(existsSync(marker)).toBe(false)
  })

  /**
   * A marker left by a crash would tell Claude Code you are sitting at a
   * machine running an app that is not running — silencing its push for the
   * whole next session.
   */
  it('clears a marker a previous run left behind, before anything can read it', () => {
    writeFileSync(marker, 'stale')
    startPresenceTracking()
    expect(existsSync(marker)).toBe(false)
  })

  it('is gone after a quit', () => {
    startPresenceTracking()
    focusedWindow = {}
    refreshPresence()
    expect(existsSync(marker)).toBe(true)
    stopPresenceTracking()
    expect(existsSync(marker)).toBe(false)
  })
})

describe('the env var Claude Code reads', () => {
  /**
   * Set on the app's own process rather than per spawn: `pty.ts` hands
   * `process.env` to every terminal, so this covers an agent SimpleEdit
   * launched and a `claude` typed into a SimpleEdit shell alike.
   */
  it('points at the marker, so a child process inherits it', () => {
    expect(process.env[PRESENCE_ENV_VAR]).toBeUndefined()
    startPresenceTracking()
    expect(process.env[PRESENCE_ENV_VAR]).toBe(presenceFilePath())
    expect(process.env[PRESENCE_ENV_VAR]).toBe(marker)
  })
})
