/**
 * The persisted Screen PRs filter (org + activity cutoff), one JSON file under
 * `userData/config`. Owned by main, like the review drafts, so desktop windows
 * and phones share one filter across reloads, restarts and devices.
 */
import { readFileSync, writeFileSync, renameSync } from 'fs'
import { join } from 'path'
import { configDir } from './config-dir'
import {
  DEFAULT_FILTER_PREFS,
  parseFilterPrefs,
  sameFilter,
  type ScreenPrsFilterPrefs,
  type ScreenPrsFilterSnapshot,
} from '../shared/screenprs-filter'

let mem: ScreenPrsFilterPrefs | null = null
/**
 * Sent with every snapshot so a client can drop one that is older than what it
 * holds — its own set's reply and another client's broadcast race. Seeded from
 * the clock so it keeps rising across a restart, which a phone page outlives.
 */
let rev = Date.now()

function filePath(): string {
  if (process.env.SIMPLEEDIT_E2E_SCREENPRS_FILTER) return process.env.SIMPLEEDIT_E2E_SCREENPRS_FILTER
  return join(configDir(), 'screenprs-filter.json')
}

function load(): ScreenPrsFilterPrefs {
  if (mem) return mem
  try {
    mem = parseFilterPrefs(JSON.parse(readFileSync(filePath(), 'utf-8')))
  } catch {
    mem = DEFAULT_FILTER_PREFS
  }
  return mem
}

export function loadFilter(): ScreenPrsFilterSnapshot {
  return { filter: load(), rev }
}

/**
 * Validate and persist `raw`. Throws on an invalid filter (the phone is a
 * remote client); `changed` is false when it matches what is stored, so a
 * no-op isn't broadcast.
 */
export function setFilter(raw: unknown): ScreenPrsFilterSnapshot & { changed: boolean } {
  const next = parseFilterPrefs(raw)
  if (sameFilter(next, load())) return { filter: load(), rev, changed: false }
  const path = filePath()
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(next), 'utf-8')
  renameSync(tmp, path)
  mem = next
  rev++
  return { filter: next, rev, changed: true }
}

/** Test seam: forget the in-memory copy so the next read goes to disk. */
export function resetFilterCache(): void {
  mem = null
}
