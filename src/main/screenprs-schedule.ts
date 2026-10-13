/**
 * Auto-screening: main starts a screening every `autoScreenHours` of the saved
 * filter, whether or not a window is open (quit stops it).
 *
 * The clock is the last screening's start, whoever started it, so a manual
 * Screen also pushes the next scheduled one back. It is persisted, so a restart
 * neither screens at once every launch nor forgets an overdue run.
 */
import { readFileSync, writeFileSync, renameSync } from 'fs'
import { join } from 'path'
import { configDir } from './config-dir'
import type { ScreenPrsSchedule } from '../shared/ipc-types'

const HOUR_MS = 3_600_000
/**
 * The soonest a due run starts after the schedule is (re)armed: at launch, on
 * wake, or when a shorter interval makes one overdue. Gives the network a
 * moment after wake, and a dev restart loop a moment before it costs a run.
 */
export const GRACE_MS = 30_000
/** How long a due run waits again while another screening is still going. */
export const BUSY_RETRY_MS = 5 * 60_000

export interface ScheduleDeps {
  /** The saved interval, in hours; 0 = off. */
  hours: () => number
  /** Whether a screening is going right now (a due run then waits for the next slot). */
  running: () => boolean
  /** Start a scheduled screening with the saved filter. */
  start: () => void
  /** Tell every client. */
  changed: (schedule: ScreenPrsSchedule) => void
  now?: () => number
}

let deps: ScheduleDeps | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let lastAt: number | undefined
let nextAt: number | undefined
let loaded = false

function filePath(): string {
  return join(configDir(), 'screenprs-schedule.json')
}

function loadLastAt(): number | undefined {
  if (loaded) return lastAt
  loaded = true
  try {
    const raw: unknown = JSON.parse(readFileSync(filePath(), 'utf-8'))
    const at = typeof raw === 'object' && raw !== null ? (raw as { lastAt?: unknown }).lastAt : undefined
    if (typeof at === 'number' && Number.isFinite(at)) lastAt = at
  } catch {
    /* never screened, or unreadable: treated as never */
  }
  return lastAt
}

function saveLastAt(at: number): void {
  const path = filePath()
  const tmp = `${path}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify({ lastAt: at }), 'utf-8')
    renameSync(tmp, path)
  } catch (err: unknown) {
    console.warn('[screenprs] saving the schedule failed:', err)
  }
}

const now = (): number => deps?.now?.() ?? Date.now()

export function screeningSchedule(): ScreenPrsSchedule {
  const last = loadLastAt()
  return { ...(last !== undefined ? { lastAt: last } : {}), ...(nextAt !== undefined ? { nextAt } : {}) }
}

/**
 * Work out the next run from the wall clock and arm one timer for it. Called on
 * every input that moves it. Timers stall while the Mac sleeps, so wake calls
 * this too rather than trusting the old timer.
 */
export function rescheduleScreening(notify = false): void {
  if (!deps) return
  if (timer) clearTimeout(timer)
  timer = null
  const hours = deps.hours()
  const before = nextAt
  if (hours <= 0) {
    nextAt = undefined
  } else {
    const due = (loadLastAt() ?? 0) + hours * HOUR_MS
    nextAt = Math.max(due, now() + (deps.running() ? BUSY_RETRY_MS : GRACE_MS))
    timer = setTimeout(fire, nextAt - now())
    timer.unref?.()
  }
  if (notify || nextAt !== before) deps.changed(screeningSchedule())
}

function fire(): void {
  timer = null
  if (!deps) return
  // A run going now (someone's manual one) already stamped `lastAt`, so the
  // reschedule below lands one interval after it.
  if (!deps.running()) deps.start()
  rescheduleScreening()
}

/** Any screening began: the interval counts from here. */
export function noteScreeningStarted(): void {
  lastAt = now()
  loaded = true
  saveLastAt(lastAt)
  rescheduleScreening(true)
}

export function startScreeningSchedule(d: ScheduleDeps): void {
  deps = d
  rescheduleScreening()
}

export function stopScreeningSchedule(): void {
  if (timer) clearTimeout(timer)
  timer = null
  deps = null
  nextAt = undefined
}
