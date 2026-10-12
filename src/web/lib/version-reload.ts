/**
 * Whether the phone app should reload because the Mac now ships a different
 * build than the one this page was loaded from.
 *
 * A Mac restart on a new version only reconnects the socket; without a reload
 * the phone keeps running the old bundle against the new main process. The
 * server stamps its build id into the served index.html (`BUILD_META_NAME`)
 * and into every `hello`; this compares the two.
 */
import { BUILD_META_NAME } from '../../shared/remote-protocol'

/** The server build this tab last reloaded for; set just before reloading. */
export const RELOAD_MARKER_KEY = 'simpleedit:reloaded-for-build'

export type ReloadAction = 'none' | 'reload' | 'prompt'

export interface ReloadInputs {
  /** The build this page was loaded from, or null for a shell without the meta tag. */
  loaded: string | null
  /** The build the Mac reported, or undefined for a server that predates the check. */
  server: string | undefined
  visible: boolean
  /**
   * The app shows the first tab's list with nothing opened over it — where a
   * reload lands anyway, so reloading doesn't move the reader.
   */
  atRoot: boolean
  /** Something a reload would throw away, or whose answer it would lose. */
  atRisk: boolean
  /** `RELOAD_MARKER_KEY`'s value. */
  reloadedFor: string | null
}

/**
 * `reload` only when nothing can be lost or moved and the user is looking; `prompt`
 * (the banner) otherwise. A reload already made for this very server build
 * that did not cure the mismatch is never repeated, so no setup can loop.
 */
export function decideReload({ loaded, server, visible, atRoot, atRisk, reloadedFor }: ReloadInputs): ReloadAction {
  if (!loaded || !server || loaded === server) return 'none'
  if (reloadedFor === server || atRisk || !visible || !atRoot) return 'prompt'
  return 'reload'
}

export function loadedBuildId(doc: Document): string | null {
  return doc.querySelector<HTMLMetaElement>(`meta[name="${BUILD_META_NAME}"]`)?.content || null
}

/**
 * Where to reload to so the page keeps the key it is using: a rescanned key
 * lives in `localStorage`, and when that was refused the URL's `?k=` is all a
 * reloaded page has (`resolveKey`). Null when the URL already carries it — a
 * plain reload then. The fragment is an instruction already acted on, so it
 * is dropped.
 */
export function reloadTarget(href: string, key: string | null): string | null {
  const url = new URL(href)
  if (!key || url.searchParams.get('k') === key) return null
  url.searchParams.set('k', key)
  url.hash = ''
  return url.toString()
}

export type StorageSource = () => Storage

const sessionStore: StorageSource = () => window.sessionStorage

export function readReloadMarker(storage: StorageSource = sessionStore): string | null {
  try {
    return storage().getItem(RELOAD_MARKER_KEY)
  } catch {
    return null
  }
}

/**
 * Record the reload about to happen. False when it could not be recorded: the
 * caller must not reload automatically then, since nothing would stop a loop.
 */
export function markReloadFor(server: string, storage: StorageSource = sessionStore): boolean {
  try {
    storage().setItem(RELOAD_MARKER_KEY, server)
    return storage().getItem(RELOAD_MARKER_KEY) === server
  } catch {
    return false
  }
}
