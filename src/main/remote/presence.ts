/**
 * "The user is at the machine", written where Claude Code can read it.
 *
 * Claude Code's Remote Control ships its own phone push and suppresses it
 * while you are at the local terminal. `CLAUDE_CLIENT_PRESENCE_FILE` is the
 * documented extension point for that check: Claude Code READS a file whose
 * mere existence means "the user is here", and a third party writes it.
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

/**
 * Re-evaluate and write, but only on a CHANGE.
 *
 * Rewriting the file every 15 seconds would be a needless disk write and,
 * worse, would hide a bug: with the write unconditional, "the marker is
 * present" stops meaning "we decided the user is here".
 */
export function refreshPresence(
  present = isUserPresent(BrowserWindow.getFocusedWindow() !== null, powerMonitor.getSystemIdleTime()),
): boolean {
  if (present === currentlyPresent) return present
  currentlyPresent = present
  const path = presenceFilePath()
  if (present) writeMarker(path)
  else removeMarker(path)
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

  app.on('browser-window-focus', () => void refreshPresence())
  app.on('browser-window-blur', () => void refreshPresence())
  timer = setInterval(() => void refreshPresence(), POLL_MS)
  // The poll exists to notice idleness, not to keep the process alive.
  timer.unref?.()
}

/** Quit, or a test tearing down. Leaves no marker behind. */
export function stopPresenceTracking(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  currentlyPresent = null
  if (existsSync(presenceFilePath())) removeMarker(presenceFilePath())
}
