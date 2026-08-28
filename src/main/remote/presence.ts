/**
 * "The user is at the machine", written where Claude Code can read it.
 *
 * Claude Code's Remote Control ships its own phone push and suppresses it
 * while you are at the local terminal. `CLAUDE_CLIENT_PRESENCE_FILE` is the
 * documented extension point for that check (Claude Code v2.1.181+):
 *
 *   - the variable holds a PATH to a marker file, which a third party writes;
 *   - the file's CONTENT is irrelevant — only its existence is checked;
 *   - notifications are skipped for as long as the file exists;
 *   - it is read once per push-triggering event, not polled.
 *
 * That last point is why there is no freshness rule here and no timestamp
 * anything reads: a stale marker is not "old", it is simply present, and
 * present means silent. Which is exactly why an abnormal exit is a problem and
 * is handled below.
 *
 * ── The asymmetry, and why it is the right lever here ─────────────────────
 * The env var EXTENDS the built-in presence check; it does not replace it.
 * So this can only ever make Remote Control quieter, never louder. That makes
 * it useless for getting more notifications out of Claude Code and exactly
 * right for de-duplication: once SimpleEdit sends its own push, a Claude
 * session sitting in a SimpleEdit terminal should not buzz the phone twice.
 *
 * ── Why focus alone is not "present" ──────────────────────────────────────
 * The plan flags the failure mode in Claude Code's own check, and writing a
 * focus-only marker would reproduce it here: a SimpleEdit window left focused
 * on a terminal pane looks present forever, so you walk away and nothing ever
 * buzzes — the precise scenario this feature exists for. Presence therefore
 * needs BOTH halves:
 *
 *   a SimpleEdit window is focused  AND  the machine has seen input recently
 *
 * `powerMonitor.getSystemIdleTime()` supplies the second, and it is what turns
 * "the app is frontmost" into "a person is there". Walking away clears the
 * marker within one poll, and Remote Control goes back to notifying — which is
 * the safe direction to fail in: a duplicate buzz costs a glance, a suppressed
 * one costs the whole reason you carried the phone.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { app, BrowserWindow, powerMonitor } from 'electron'

/**
 * Seconds of no keyboard or mouse input after which a focused window stops
 * counting as a person. Short enough that a walk to the kitchen releases it,
 * long enough to survive reading a diff.
 */
export const IDLE_THRESHOLD_SECONDS = 120

/** How often presence is re-evaluated. Focus events are instant; idleness is not. */
const POLL_MS = 15_000

export const PRESENCE_ENV_VAR = 'CLAUDE_CLIENT_PRESENCE_FILE'

/**
 * The predicate, separated from everything that makes it hard to test.
 *
 * Both halves, in this order, are the whole design decision of this module.
 */
export function isUserPresent(anyWindowFocused: boolean, systemIdleSeconds: number): boolean {
  return anyWindowFocused && systemIdleSeconds < IDLE_THRESHOLD_SECONDS
}

export function presenceFilePath(): string {
  if (process.env.SIMPLEEDIT_E2E_PRESENCE_FILE) return process.env.SIMPLEEDIT_E2E_PRESENCE_FILE
  const dir = join(app.getPath('userData'), 'presence')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'local-client-present')
}

let timer: NodeJS.Timeout | null = null
let currentlyPresent: boolean | null = null
/** Registered once and removed on stop, so a reopen cycle cannot stack them. */
let focusHandler: (() => void) | null = null
let blurHandler: (() => void) | null = null

function writeMarker(path: string): void {
  try {
    writeFileSync(path, String(Date.now()), { encoding: 'utf8', mode: 0o600 })
  } catch {
    /* a marker that cannot be written just means Remote Control stays noisy */
  }
}

function removeMarker(path: string): void {
  try {
    rmSync(path, { force: true })
  } catch {
    /* same: failing to clear it only costs a suppressed duplicate */
  }
}

/** Is a person at this machine right now? Evaluated fresh, never cached. */
export function isPresentNow(): boolean {
  try {
    return isUserPresent(BrowserWindow.getFocusedWindow() !== null, powerMonitor.getSystemIdleTime())
  } catch {
    // No window system, or no power monitor. "Not present" is the safe answer:
    // it costs a duplicate notification, where the other way costs a missed one.
    return false
  }
}

/**
 * Re-evaluate, and make the file on disk match the decision.
 *
 * Deliberately NOT write-only-on-change. The file is shared state that
 * something outside this process can move: a second SimpleEdit instance clears
 * it at startup (it cannot tell a live instance's marker from one a crash left
 * behind), and a user or a cleanup script can delete it. With a change-only
 * write, the first instance would go on believing it had written a marker that
 * no longer exists, and would never write it again — Remote Control would
 * start notifying while the user sat in front of the app.
 *
 * So the decision is cached to avoid pointless writes, and the file is checked
 * against it so any external divergence is repaired on the next poll.
 */
export function refreshPresence(present = isPresentNow()): boolean {
  const path = presenceFilePath()
  const onDisk = existsSync(path)
  if (present === currentlyPresent && onDisk === present) return present
  currentlyPresent = present
  if (present) {
    if (!onDisk) writeMarker(path)
  } else if (onDisk) {
    removeMarker(path)
  }
  return present
}

/**
 * Point Claude Code at the marker and start maintaining it.
 *
 * The env var is set on the app's own process, not on each spawn, because
 * `pty.ts` hands `process.env` to every terminal it opens — so this covers an
 * agent SimpleEdit launched and a `claude` the user typed into a SimpleEdit
 * shell, with no per-provider wiring to keep in step.
 *
 * A marker left behind by a crash would silence Remote Control indefinitely
 * on the next run, so startup clears it before anything can read it.
 */
export function startPresenceTracking(): void {
  if (timer) return
  const path = presenceFilePath()
  process.env[PRESENCE_ENV_VAR] = path
  // Nobody is present at launch, whatever a previous run left on disk.
  currentlyPresent = null
  removeMarker(path)
  currentlyPresent = false

  focusHandler = () => void refreshPresence()
  blurHandler = () => void refreshPresence()
  app.on('browser-window-focus', focusHandler)
  app.on('browser-window-blur', blurHandler)
  timer = setInterval(() => void refreshPresence(), POLL_MS)
  // The poll exists to notice idleness, not to keep the process alive.
  timer.unref?.()
  installExitHandlers()
}

/**
 * `before-quit` is not the only way this process ends.
 *
 * A marker left behind silences Claude Code's push for anything that outlives
 * us — bounded to processes that inherited the variable, but indefinitely for
 * those. A terminal `^C` and a `kill` are both ordinary ways to stop a dev
 * build, and neither runs Electron's quit handlers.
 *
 * SIGKILL and a hard crash cannot be caught by anyone, so the marker does
 * survive those. The next launch clears it before anything reads it, which
 * bounds the damage to processes that outlived the crash — stated plainly
 * because it is a real gap, not a covered one.
 */
let exitHandlersInstalled = false

function installExitHandlers(): void {
  if (exitHandlersInstalled) return
  exitHandlersInstalled = true
  const clear = (): void => removeMarker(presenceFilePath())
  // `exit` is synchronous-only, which is all `rmSync` needs.
  process.once('exit', clear)
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.once(signal, () => {
      clear()
      // Re-raise so the default disposition still applies: swallowing it would
      // make SimpleEdit unkillable by the very signal a user reached for.
      process.kill(process.pid, signal)
    })
  }
}

/** Quit, or a test tearing down. Leaves no marker behind. */
export function stopPresenceTracking(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  // Removed, not merely forgotten: `startPresenceTracking` runs again on
  // `activate`, and a listener per reopen cycle is a leak that announces itself
  // as MaxListenersExceededWarning around the ninth window.
  if (focusHandler) app.off('browser-window-focus', focusHandler)
  if (blurHandler) app.off('browser-window-blur', blurHandler)
  focusHandler = null
  blurHandler = null
  currentlyPresent = null
  if (existsSync(presenceFilePath())) removeMarker(presenceFilePath())
}
