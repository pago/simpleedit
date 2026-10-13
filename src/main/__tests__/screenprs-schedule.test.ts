import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ScreenPrsSchedule } from '../../shared/ipc-types'

const tmpRoot = mkdtempSync(join(tmpdir(), 'se-schedule-test-'))
vi.mock('electron', () => ({ app: { getPath: () => tmpRoot } }))
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }))

const FILE = join(tmpRoot, 'config', 'screenprs-schedule.json')
const HOUR = 3_600_000
const T0 = new Date('2026-10-13T08:00:00Z').getTime()

let schedule: typeof import('../screenprs-schedule')
let hours: number
let running: boolean
let starts: number
let changes: ScreenPrsSchedule[]

function arm(): void {
  schedule.startScreeningSchedule({
    hours: () => hours,
    running: () => running,
    // What screenprs.ts does on a real start: stamp the clock synchronously.
    start: () => {
      starts++
      schedule.noteScreeningStarted()
    },
    changed: (s) => changes.push(s),
  })
}

beforeEach(async () => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
  vi.resetModules()
  rmSync(FILE, { force: true })
  mkdirSync(join(tmpRoot, 'config'), { recursive: true })
  hours = 0
  running = false
  starts = 0
  changes = []
  schedule = await import('../screenprs-schedule')
})

afterEach(() => {
  schedule.stopScreeningSchedule()
  vi.useRealTimers()
})

describe('auto-screening schedule', () => {
  it('never screens while off', () => {
    arm()
    vi.advanceTimersByTime(48 * HOUR)
    expect(starts).toBe(0)
    expect(schedule.screeningSchedule()).toEqual({})
  })

  it('screens soon after launch when it has never screened, then every interval', () => {
    hours = 2
    arm()
    expect(schedule.screeningSchedule().nextAt).toBe(T0 + schedule.GRACE_MS)
    vi.advanceTimersByTime(schedule.GRACE_MS)
    expect(starts).toBe(1)
    vi.advanceTimersByTime(2 * HOUR - 1)
    expect(starts).toBe(1)
    vi.advanceTimersByTime(1)
    expect(starts).toBe(2)
  })

  it('counts from the last screening across a restart, so a launch does not screen again', async () => {
    writeFileSync(FILE, JSON.stringify({ lastAt: T0 - HOUR }))
    hours = 4
    arm()
    expect(schedule.screeningSchedule()).toEqual({ lastAt: T0 - HOUR, nextAt: T0 + 3 * HOUR })
    vi.advanceTimersByTime(3 * HOUR - 1)
    expect(starts).toBe(0)
    vi.advanceTimersByTime(1)
    expect(starts).toBe(1)
    expect(JSON.parse(readFileSync(FILE, 'utf-8'))).toEqual({ lastAt: T0 + 3 * HOUR })
  })

  it('pushes the next run back when someone screens by hand', () => {
    writeFileSync(FILE, JSON.stringify({ lastAt: T0 }))
    hours = 1
    arm()
    vi.advanceTimersByTime(HOUR / 2)
    schedule.noteScreeningStarted()
    expect(schedule.screeningSchedule().nextAt).toBe(T0 + HOUR / 2 + HOUR)
    vi.advanceTimersByTime(HOUR / 2)
    expect(starts).toBe(0)
    expect(changes.at(-1)).toEqual({ lastAt: T0 + HOUR / 2, nextAt: T0 + HOUR / 2 + HOUR })
  })

  it('leaves a run that is already going alone, and checks back every few minutes, not every grace', () => {
    writeFileSync(FILE, JSON.stringify({ lastAt: T0 }))
    hours = 1
    arm()
    running = true
    vi.advanceTimersByTime(HOUR)
    expect(starts).toBe(0)
    const before = changes.length
    vi.advanceTimersByTime(schedule.BUSY_RETRY_MS - 1)
    expect(changes.length).toBe(before)
    running = false
    vi.advanceTimersByTime(1)
    expect(starts).toBe(1)
  })

  it('follows an interval change at once, starting an overdue run after the grace', () => {
    writeFileSync(FILE, JSON.stringify({ lastAt: T0 - 3 * HOUR }))
    hours = 16
    arm()
    expect(schedule.screeningSchedule().nextAt).toBe(T0 + 13 * HOUR)
    hours = 1
    schedule.rescheduleScreening()
    expect(schedule.screeningSchedule().nextAt).toBe(T0 + schedule.GRACE_MS)
    hours = 0
    schedule.rescheduleScreening()
    vi.advanceTimersByTime(24 * HOUR)
    expect(starts).toBe(0)
    expect(changes.at(-1)).toEqual({ lastAt: T0 - 3 * HOUR })
  })

  it('catches up on wake from the wall clock, not the stalled timer', () => {
    writeFileSync(FILE, JSON.stringify({ lastAt: T0 }))
    hours = 2
    arm()
    // Asleep for 5 hours: the clock moved, the timer did not.
    vi.setSystemTime(T0 + 5 * HOUR)
    schedule.rescheduleScreening()
    expect(schedule.screeningSchedule().nextAt).toBe(T0 + 5 * HOUR + schedule.GRACE_MS)
    vi.advanceTimersByTime(schedule.GRACE_MS)
    expect(starts).toBe(1)
  })

  it('stops for good at quit', () => {
    hours = 1
    arm()
    schedule.stopScreeningSchedule()
    vi.advanceTimersByTime(48 * HOUR)
    expect(starts).toBe(0)
  })
})
