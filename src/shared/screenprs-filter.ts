/**
 * The Screen PRs filter — which org to screen and how far back — as one saved
 * preference. Main owns it (main/screenprs-filter.ts) and every desktop window
 * and phone mirrors it, so setting the org on one applies to all of them and
 * survives a restart.
 */
import type { ScreenPrsFilters } from './ipc-types'

/** The activity cutoffs both clients offer. Days, because a phone should not type a date. */
export const CUTOFF_DAYS = [7, 30, 90] as const
export type CutoffDays = (typeof CUTOFF_DAYS)[number]

export interface ScreenPrsFilterPrefs {
  /** GitHub org or user to scope to; `''` = every org where you're a reviewer. */
  owner: string
  cutoffDays: CutoffDays
}

/** The filter main holds, and the revision it stands at. */
export interface ScreenPrsFilterSnapshot {
  filter: ScreenPrsFilterPrefs
  rev: number
}

export const DEFAULT_FILTER_PREFS: ScreenPrsFilterPrefs = { owner: '', cutoffDays: 30 }

/** GitHub's own rule for a login or org name: alphanumerics and single inner hyphens, at most 39. */
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/

/** Whether `name` could be a GitHub login or org. Empty is not a name. */
export function isOwnerName(name: string): boolean {
  return OWNER.test(name)
}

export function isCutoffDays(value: unknown): value is CutoffDays {
  return typeof value === 'number' && (CUTOFF_DAYS as readonly number[]).includes(value)
}

/**
 * A filter from outside — a phone, or the file on disk. Throws with a reason a
 * client can show. The owner is passed to `gh` as an argument, so it is held to
 * GitHub's name rule rather than merely trimmed.
 */
export function parseFilterPrefs(raw: unknown): ScreenPrsFilterPrefs {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('A Screen PRs filter must be an object.')
  const { owner, cutoffDays } = raw as Record<string, unknown>
  if (typeof owner !== 'string') throw new Error('The Screen PRs org must be a string.')
  const trimmed = owner.trim()
  if (trimmed && !isOwnerName(trimmed)) throw new Error(`“${trimmed}” isn't a GitHub org or user name.`)
  if (!isCutoffDays(cutoffDays)) throw new Error(`The activity cutoff must be one of ${CUTOFF_DAYS.join(', ')} days.`)
  return { owner: trimmed, cutoffDays }
}

export function sameFilter(a: ScreenPrsFilterPrefs, b: ScreenPrsFilterPrefs): boolean {
  return a.owner === b.owner && a.cutoffDays === b.cutoffDays
}

/** What `screenprs:start` takes for these prefs, with the cutoff resolved against `now`. */
export function screeningFilters(prefs: ScreenPrsFilterPrefs, now: Date = new Date()): ScreenPrsFilters {
  const since = new Date(now)
  since.setDate(since.getDate() - prefs.cutoffDays)
  return {
    ...(prefs.owner ? { owner: prefs.owner } : {}),
    updatedSince: since.toISOString().slice(0, 10),
  }
}

/** Whether `value` is a real calendar date written `YYYY-MM-DD` (so not `2026-99-99`). */
export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const d = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value
}

/**
 * `screenprs:start`'s argument, from a phone as readily as from a window.
 * The owner and the date both reach `gh` as arguments, so both are held to
 * what GitHub accepts rather than passed through. Throws the reason.
 */
export function parseScreeningFilters(raw: unknown): ScreenPrsFilters {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('Screening filters must be an object.')
  const { owner, updatedSince, force } = raw as Record<string, unknown>
  if (owner !== undefined && (typeof owner !== 'string' || !isOwnerName(owner))) {
    throw new Error(`“${String(owner)}” isn't a GitHub org or user name.`)
  }
  if (updatedSince !== undefined && (typeof updatedSince !== 'string' || !isIsoDate(updatedSince))) {
    throw new Error('The activity cutoff must be a real YYYY-MM-DD date.')
  }
  if (force !== undefined && typeof force !== 'boolean') throw new Error('`force` must be true or false.')
  return {
    ...(owner !== undefined ? { owner } : {}),
    ...(updatedSince !== undefined ? { updatedSince } : {}),
    ...(force ? { force } : {}),
  }
}
