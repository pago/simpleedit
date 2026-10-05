/**
 * Which project this phone attaches to, remembered on the device.
 *
 * The phone borrows one Mac window's identity, and without a remembered
 * choice main picks whichever window has focus at the moment the socket
 * connects. That made the project change under the user on any reconnect —
 * a locked screen is enough — whenever the Mac's focus had moved.
 *
 * So the phone remembers a project and names it on every connect (the socket
 * URL's `window` and `repo` parameters; main decides in `attach-target.ts`).
 * The repo is what is remembered: a window id is only good until the app
 * restarts, so it is sent as a hint and main honours it only alongside the
 * repo.
 *
 * Kept under its own storage key, apart from anything about the access key:
 * changing how the device stores its key must not forget the project, and
 * re-pairing must not either.
 */
import type { RemoteProject } from '../../shared/ipc-types'

export interface RememberedProject {
  repoPath: string
  windowId: number
  name: string
}

export const PROJECT_STORAGE_KEY = 'simpleedit.pocket.project'

/** `localStorage`, or null where it is unavailable or throws (private mode, a sandboxed test). */
function defaultStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

/**
 * This page's latest pick, which wins over storage. Without it a device whose
 * storage refuses writes would reconnect asking for nothing, land wherever the
 * Mac's focus is, and the switch the user just made would do nothing.
 */
let picked: RememberedProject | null = null

/** For tests: forget this page's pick. */
export function resetPickedProject(): void {
  picked = null
}

export function loadRememberedProject(storage: Storage | null = defaultStorage()): RememberedProject | null {
  if (picked) return picked
  let raw: string | null
  try {
    raw = storage?.getItem(PROJECT_STORAGE_KEY) ?? null
  } catch {
    return null
  }
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const { repoPath, windowId, name } = parsed as Record<string, unknown>
    if (typeof repoPath !== 'string' || repoPath === '') return null
    return {
      repoPath,
      windowId: typeof windowId === 'number' && Number.isInteger(windowId) ? windowId : 0,
      name: typeof name === 'string' && name !== '' ? name : repoPath,
    }
  } catch {
    return null
  }
}

export function rememberProject(
  project: Pick<RemoteProject, 'repoPath' | 'windowId' | 'name'>,
  storage: Storage | null = defaultStorage(),
): void {
  const value: RememberedProject = { repoPath: project.repoPath, windowId: project.windowId, name: project.name }
  picked = value
  try {
    storage?.setItem(PROJECT_STORAGE_KEY, JSON.stringify(value))
  } catch {
    /* full or blocked: `picked` still holds it for this page's life */
  }
}

/** The query a socket URL carries to name its project. Empty when nothing is remembered. */
export function attachParams(project: RememberedProject | null): Record<string, string> {
  if (!project) return {}
  const params: Record<string, string> = { repo: project.repoPath }
  if (project.windowId > 0) params.window = String(project.windowId)
  return params
}

/**
 * What to tell the user about where the phone just attached, or null for nothing.
 *
 * Two cases, and both are the project changing without the user asking:
 *
 *  - It landed somewhere other than the remembered project, because that
 *    window is not open on the Mac (closed, or the app restarted without it)
 *    and main fell back to its focus rule.
 *  - It is on a different project from the one this page was showing, and the
 *    user did not pick it — the remembered project's window is back, and the
 *    reconnect returned to it.
 *
 * Silence in either case leaves the user to work it out from an unfamiliar
 * session list.
 */
export function attachNotice(input: {
  /** The remembered project, if the device has one. */
  expected: Pick<RememberedProject, 'repoPath' | 'name'> | null
  /** What this page was showing before this attach, if anything. */
  previous: Pick<RememberedProject, 'repoPath' | 'name'> | null
  landed: RemoteProject | null
  /** The user picked a project and this attach is the answer to that. */
  chosen: boolean
}): string | null {
  const { expected, previous, landed, chosen } = input
  if (expected && landed?.repoPath !== expected.repoPath) {
    return landed
      ? `${expected.name} isn't open on the Mac, so this phone is showing ${landed.name} until it is.`
      : `${expected.name} isn't open on the Mac, and no other window has a project open.`
  }
  if (!chosen && previous && landed && previous.repoPath !== landed.repoPath) {
    return `Now showing ${landed.name} (was ${previous.name}).`
  }
  return null
}

/**
 * Which `hello` a project pick is answered by.
 *
 * Each `hello` starts an attach that then awaits the project list, and an
 * older attach's list can arrive after a newer `hello` — to the same window,
 * so comparing window ids cannot tell them apart. Only the latest attach may
 * judge, and only it may consume a pending pick; a stale one consuming it
 * would have the real answer report the user's own switch as news.
 */
export class AttachSequence {
  #generation = 0
  #pickPending = false

  /** The user picked a project; the attach that answers it is not news. */
  expectPick(): void {
    this.#pickPending = true
  }

  /** A new `hello`. Returns its token. */
  begin(): number {
    return ++this.#generation
  }

  /**
   * Judge the attach `token` started: null when a newer one has begun (drop
   * the result, leave the pick pending), else whether it answers a pick.
   */
  settle(token: number): { chosen: boolean } | null {
    if (token !== this.#generation) return null
    const chosen = this.#pickPending
    this.#pickPending = false
    return { chosen }
  }
}
