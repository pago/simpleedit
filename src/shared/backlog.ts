/**
 * The session backlog: per project, an ordered list of prepared session
 * prompts the user starts later. Main owns it (`main/backlog-store.ts`);
 * desktop windows and phones mirror it through `backlog:changed`, and agents
 * add to it over MCP.
 *
 * A backlog belongs to the PROJECT, the repo the window was opened on — never
 * to a repo an agent merely works in. Sessions launch at the project root to
 * share one Claude memory, so the session an item becomes must too.
 */
import type { InteractiveTarget } from './ipc-types'

export type BacklogItemOrigin = 'desktop' | 'phone' | 'agent'

/** How the last attempt to start an item ended, when it did not start it. */
export interface BacklogStartIssue {
  /**
   * `failed`: nothing started. `unconfirmed`: the request reached the window
   * but no answer came back, so a session may exist.
   */
  outcome: 'failed' | 'unconfirmed'
  reason: string
  at: string
}

export interface BacklogItem {
  /** Minted by whoever adds it (`b_…`), never reused. */
  id: string
  /** The new session's opening message. Sent verbatim. */
  prompt: string
  /** Sidebar name for the session. Absent: one derived from the prompt. */
  label?: string
  /**
   * The agent and model to start, never with a reasoning effort: the session
   * gets the provider's default. Absent: the desk's default. It starts in the
   * main worktree.
   */
  target?: InteractiveTarget
  /** Goes up on every edit, so a stale editor's save is refused, not applied. */
  version: number
  createdAt: string
  updatedAt: string
  createdBy: BacklogItemOrigin
  /** Agent items: the label of the session that added it. */
  createdBySession?: string
  /** Cleared by the next edit or a successful start. */
  lastStart?: BacklogStartIssue
  /** A start is in flight: the item can't be edited until it settles. */
  starting?: boolean
}

export interface NewBacklogItem {
  id: string
  prompt: string
  label?: string
  target?: InteractiveTarget
}

/** `null` clears an optional field. */
export interface BacklogItemPatch {
  prompt?: string
  label?: string | null
  target?: InteractiveTarget | null
}

export type BacklogOp =
  /** At `index` (0 = top), else at the end. */
  | { kind: 'add'; item: NewBacklogItem; index?: number }
  /** With `baseVersion`, refused when the item changed since. Without, it always applies. */
  | { kind: 'update'; id: string; baseVersion?: number; patch: BacklogItemPatch }
  | { kind: 'remove'; id: string }
  /** Listed ids first, in this order; the rest keep their order after them. */
  | { kind: 'reorder'; ids: string[] }

export interface BacklogSnapshot {
  /** The project's bare repo path. */
  project: string
  items: BacklogItem[]
  rev: number
}

export type BacklogOpResult =
  | { ok: true; snapshot: BacklogSnapshot }
  /**
   * An `update` whose `baseVersion` is stale, or whose item is gone
   * (`current: null`). Nothing in the batch was applied.
   */
  | { ok: false; conflict: { id: string; current: BacklogItem | null }; snapshot: BacklogSnapshot }

/** Most ops in one `backlog:op` or `edit_backlog` batch. */
export const BACKLOG_MAX_OPS = 50
/** Most items one project's backlog holds. */
export const BACKLOG_MAX_ITEMS = 200

const ID = /^b_[A-Za-z0-9]{8,32}$/

export function isBacklogItemId(v: unknown): v is string {
  return typeof v === 'string' && ID.test(v)
}

export function newBacklogItemId(): string {
  return `b_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`
}
