/**
 * Session backlogs, persisted in the app database. Main owns them; desktop
 * windows and phones mirror a project's backlog through `backlog:changed`.
 *
 * Every client change and every `edit_backlog` call is a batch of
 * `BacklogOp`s, applied all or nothing in one transaction. Only main applies
 * them, so there is no client copy of this logic to keep in step.
 *
 * Ids are minted by whoever adds an item and never reused, and a removed or
 * started item's id is tombstoned: a client that retries an add whose answer
 * it lost must not bring the item back.
 */
import { getDb, transaction } from './db'
import { parseCreateLabel, parseCreateTarget } from './session-create'
import { SESSION_BRIEF_MAX } from '../shared/brief'
import {
  BACKLOG_MAX_ITEMS,
  BACKLOG_MAX_OPS,
  isBacklogItemId,
  type BacklogItem,
  type BacklogItemOrigin,
  type BacklogItemPatch,
  type BacklogOp,
  type BacklogOpResult,
  type BacklogSnapshot,
  type BacklogStartIssue,
  type NewBacklogItem,
} from '../shared/backlog'
import type { InteractiveTarget } from '../shared/ipc-types'

/**
 * Bumped on every change and sent with every snapshot, so a client can drop an
 * answer older than a broadcast it already applied. Seeded from the clock so it
 * keeps rising across a restart, which a phone page outlives.
 */
let rev = Date.now()

/** Items with a start in flight. Edits to them are refused until it settles. */
const starting = new Set<string>()

interface ItemRow {
  id: string
  prompt: string
  label: string | null
  target: string | null
  version: number
  created_at: string
  updated_at: string
  created_by: string
  created_by_session: string | null
  last_start: string | null
}

function toItem(r: ItemRow): BacklogItem {
  const item: BacklogItem = {
    id: r.id,
    prompt: r.prompt,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    createdBy: r.created_by === 'phone' || r.created_by === 'agent' ? r.created_by : 'desktop',
  }
  if (r.label) item.label = r.label
  if (r.target) item.target = JSON.parse(r.target) as InteractiveTarget
  if (r.created_by_session) item.createdBySession = r.created_by_session
  if (r.last_start) item.lastStart = JSON.parse(r.last_start) as BacklogStartIssue
  if (starting.has(r.id)) item.starting = true
  return item
}

function itemRow(project: string, id: string): ItemRow | undefined {
  return getDb().prepare('SELECT * FROM backlog_items WHERE project = ? AND id = ?').get(project, id) as ItemRow | undefined
}

export function getBacklogItem(project: string, id: string): BacklogItem | null {
  const row = itemRow(project, id)
  return row ? toItem(row) : null
}

export function loadBacklog(project: string): BacklogSnapshot {
  const rows = getDb().prepare('SELECT * FROM backlog_items WHERE project = ? ORDER BY position').all(project) as unknown as ItemRow[]
  return { project, items: rows.map(toItem), rev }
}

function orderedIds(project: string): string[] {
  const rows = getDb().prepare('SELECT id FROM backlog_items WHERE project = ? ORDER BY position').all(project) as Array<{ id: string }>
  return rows.map((r) => r.id)
}

function writeOrder(project: string, ids: readonly string[]): void {
  const set = getDb().prepare('UPDATE backlog_items SET position = ? WHERE project = ? AND id = ?')
  ids.forEach((id, i) => set.run(i, project, id))
}

/**
 * The order a `reorder` asks for: the listed ids that exist, in the listed
 * order, then every other id in its current order. An item added since the
 * caller last looked is therefore kept, never dropped.
 */
export function reorderIds(current: readonly string[], wanted: readonly string[]): string[] {
  const known = new Set(current)
  const head: string[] = []
  for (const id of wanted) if (known.has(id) && !head.includes(id)) head.push(id)
  const placed = new Set(head)
  return [...head, ...current.filter((id) => !placed.has(id))]
}

function tombstoned(id: string): boolean {
  return getDb().prepare('SELECT 1 FROM backlog_tombstones WHERE id = ?').get(id) !== undefined
}

function exists(id: string): boolean {
  return getDb().prepare('SELECT 1 FROM backlog_items WHERE id = ?').get(id) !== undefined
}

function removeItem(project: string, id: string, at: string): boolean {
  const d = getDb()
  const r = d.prepare('DELETE FROM backlog_items WHERE project = ? AND id = ?').run(project, id)
  if (!r.changes) return false
  d.prepare('INSERT OR IGNORE INTO backlog_tombstones (id, project, at) VALUES (?, ?, ?)').run(id, project, at)
  // A retried add comes within moments of the original, so the newest are all that matter.
  d.prepare(
    `DELETE FROM backlog_tombstones WHERE project = ? AND rowid NOT IN
       (SELECT rowid FROM backlog_tombstones WHERE project = ? ORDER BY at DESC, rowid DESC LIMIT ?)`,
  ).run(project, project, BACKLOG_MAX_TOMBSTONES)
  return true
}

/** Removed or started ids remembered per project. */
export const BACKLOG_MAX_TOMBSTONES = 500

/** Thrown inside the batch's transaction to roll it back and report the conflict. */
class Conflict extends Error {
  constructor(readonly id: string) {
    super('Backlog conflict')
  }
}

export interface Origin {
  createdBy: BacklogItemOrigin
  /** Agent adds: the label of the session that made them. */
  createdBySession?: string
}

function applyOne(project: string, op: BacklogOp, origin: Origin, at: string): boolean {
  const d = getDb()
  switch (op.kind) {
    case 'add': {
      const { item } = op
      if (tombstoned(item.id) || exists(item.id)) return false
      const ids = orderedIds(project)
      if (ids.length >= BACKLOG_MAX_ITEMS) throw new Error(`This backlog already holds ${BACKLOG_MAX_ITEMS} items.`)
      d.prepare(
        `INSERT INTO backlog_items (id, project, position, prompt, label, target, version, created_at, updated_at, created_by, created_by_session, last_start)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, NULL)`,
      ).run(
        item.id,
        project,
        ids.length,
        item.prompt,
        item.label ?? null,
        item.target ? JSON.stringify(item.target) : null,
        at,
        at,
        origin.createdBy,
        origin.createdBySession ?? null,
      )
      if (op.index !== undefined && op.index < ids.length) {
        ids.splice(Math.max(0, op.index), 0, item.id)
        writeOrder(project, ids)
      }
      return true
    }
    case 'update': {
      const row = itemRow(project, op.id)
      if (!row || starting.has(op.id)) throw new Conflict(op.id)
      if (op.baseVersion !== undefined && op.baseVersion !== row.version) throw new Conflict(op.id)
      const { patch } = op
      const next = {
        prompt: patch.prompt ?? row.prompt,
        label: patch.label === undefined ? row.label : patch.label,
        target: patch.target === undefined ? row.target : patch.target === null ? null : JSON.stringify(patch.target),
      }
      requireTitleOrPrompt(next.prompt, next.label)
      if (
        next.prompt === row.prompt &&
        next.label === row.label &&
        next.target === row.target
      ) {
        return false
      }
      d.prepare(
        'UPDATE backlog_items SET prompt = ?, label = ?, target = ?, version = version + 1, updated_at = ?, last_start = NULL WHERE id = ?',
      ).run(next.prompt, next.label, next.target, at, op.id)
      return true
    }
    case 'remove': {
      if (starting.has(op.id)) throw new Conflict(op.id)
      if (!removeItem(project, op.id, at)) return false
      writeOrder(project, orderedIds(project))
      return true
    }
    case 'reorder': {
      const current = orderedIds(project)
      const next = reorderIds(current, op.ids)
      if (next.every((id, i) => id === current[i])) return false
      writeOrder(project, next)
      return true
    }
  }
}

/**
 * Apply a batch to `project`'s backlog, all or nothing. `changed` says whether
 * anything was written, so the caller broadcasts only real changes.
 */
export function applyBacklogOps(
  project: string,
  ops: readonly BacklogOp[],
  origin: Origin,
  now = new Date(),
): { result: BacklogOpResult; changed: boolean } {
  const at = now.toISOString()
  try {
    const changed = transaction(getDb(), () => ops.map((op) => applyOne(project, op, origin, at)).some(Boolean))
    if (changed) rev++
    return { result: { ok: true, snapshot: loadBacklog(project) }, changed }
  } catch (err) {
    if (!(err instanceof Conflict)) throw err
    return { result: { ok: false, conflict: { id: err.id, current: getBacklogItem(project, err.id) }, snapshot: loadBacklog(project) }, changed: false }
  }
}

/** Mark an item as being started, or no longer. Bumps `rev`: the item's `starting` flag is part of what clients see. */
export function setStarting(id: string, on: boolean): void {
  if (on) starting.add(id)
  else starting.delete(id)
  rev++
}

export function isStarting(id: string): boolean {
  return starting.has(id)
}

/** The item became a session: it leaves the backlog for good. */
export function removeStartedItem(project: string, id: string, now = new Date()): boolean {
  const at = now.toISOString()
  const removed = transaction(getDb(), () => {
    if (!removeItem(project, id, at)) return false
    writeOrder(project, orderedIds(project))
    return true
  })
  if (removed) rev++
  return removed
}

/** A start that didn't produce a session (or might have): the item stays, and says why. */
export function recordStartIssue(project: string, id: string, issue: BacklogStartIssue): boolean {
  const r = getDb().prepare('UPDATE backlog_items SET last_start = ? WHERE project = ? AND id = ?').run(JSON.stringify(issue), project, id)
  if (r.changes) rev++
  return r.changes > 0
}

/** Test seam. */
export function _resetBacklogForTests(): void {
  starting.clear()
}

// ── Validation ─────────────────────────────────────────────
// Ops arrive from a socket (the phone) or an agent and are written to disk,
// so each is rebuilt from only the fields it knows. Anything malformed throws,
// and nothing in the batch is applied.

const BACKLOG_EMPTY_ITEM = 'A backlog item needs a title or a prompt.'

function requireTitleOrPrompt(prompt: string, label: string | null | undefined): void {
  if (!prompt.trim() && !label?.trim()) throw new Error(BACKLOG_EMPTY_ITEM)
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * A prompt is sent verbatim, so it is bounded by what a session will start from.
 * It may be blank: an item needs a title or a prompt (`requireTitleOrPrompt`),
 * and starting one needs a prompt.
 */
export function parseBacklogPrompt(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('A backlog prompt must be text.')
  if (raw.length > SESSION_BRIEF_MAX) {
    throw new Error(`That prompt is ${raw.length} characters; the limit is ${SESSION_BRIEF_MAX}.`)
  }
  return raw
}

/** A session started from an item gets the provider's default effort, so none is kept. */
function parseItemTarget(raw: unknown): InteractiveTarget {
  const target = parseCreateTarget(raw)
  if (target.provider === 'claude') return target
  return { provider: target.provider, ...(target.model ? { model: target.model } : {}) }
}

function parseNewItem(raw: unknown): NewBacklogItem {
  if (!isObject(raw) || !isBacklogItemId(raw.id)) throw new Error('Malformed backlog item')
  const item: NewBacklogItem = { id: raw.id, prompt: parseBacklogPrompt(raw.prompt) }
  const label = parseCreateLabel(raw.label)
  if (label) item.label = label
  if (raw.target !== undefined) item.target = parseItemTarget(raw.target)
  requireTitleOrPrompt(item.prompt, item.label)
  return item
}

function parsePatch(raw: unknown): BacklogItemPatch {
  if (!isObject(raw)) throw new Error('Malformed backlog edit')
  const patch: BacklogItemPatch = {}
  if (raw.prompt !== undefined) patch.prompt = parseBacklogPrompt(raw.prompt)
  if (raw.label !== undefined) patch.label = raw.label === null ? null : (parseCreateLabel(raw.label) ?? null)
  if (raw.target !== undefined) patch.target = raw.target === null ? null : parseItemTarget(raw.target)
  return patch
}

function parseOp(raw: unknown): BacklogOp {
  if (!isObject(raw)) throw new Error('Malformed backlog op')
  switch (raw.kind) {
    case 'add': {
      const index = raw.index
      if (index !== undefined && (typeof index !== 'number' || !Number.isInteger(index) || index < 0)) break
      return { kind: 'add', item: parseNewItem(raw.item), ...(index !== undefined ? { index } : {}) }
    }
    case 'update': {
      const base = raw.baseVersion
      if (!isBacklogItemId(raw.id)) break
      if (base !== undefined && (typeof base !== 'number' || !Number.isInteger(base))) break
      return { kind: 'update', id: raw.id, ...(base !== undefined ? { baseVersion: base } : {}), patch: parsePatch(raw.patch) }
    }
    case 'remove':
      if (!isBacklogItemId(raw.id)) break
      return { kind: 'remove', id: raw.id }
    case 'reorder':
      if (!Array.isArray(raw.ids) || raw.ids.length > BACKLOG_MAX_ITEMS || !raw.ids.every(isBacklogItemId)) break
      return { kind: 'reorder', ids: raw.ids }
  }
  throw new Error('Malformed backlog op')
}

export function parseBacklogOps(raw: unknown): BacklogOp[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('A backlog edit needs at least one op.')
  if (raw.length > BACKLOG_MAX_OPS) throw new Error(`A backlog edit takes at most ${BACKLOG_MAX_OPS} ops.`)
  return raw.map(parseOp)
}
