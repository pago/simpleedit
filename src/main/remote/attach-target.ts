/**
 * Which window a phone's socket joins.
 *
 * The phone borrows a window's identity (see `server.ts`), so "which project"
 * is "which window". A socket may NAME one in its URL — the project the phone
 * remembers — and this module decides whether to honour it. The name comes
 * from a remote client, so it is only ever compared against the window list,
 * never used as a path, and anything malformed is read as no request at all.
 *
 * Window ids do not survive a restart of the app, and can be reused by a
 * different window after one, so a request carries the repo as well and the
 * id is honoured only when that window still has that repo.
 */
import { basename } from 'path'
import type { RemoteProject } from '../../shared/ipc-types'

export interface AttachRequest {
  windowId: number | null
  repoPath: string | null
}

/** What `chooseAttachWindow` needs to know about one open window. */
export interface WindowCandidate {
  windowId: number
  repoPath: string | null
  focused: boolean
}

const MAX_REPO_PATH = 4096

/** The `window` / `repo` query parameters of a socket URL, or null when it names neither. */
export function parseAttachRequest(url: string | undefined): AttachRequest | null {
  if (!url) return null
  const query = url.indexOf('?')
  if (query === -1) return null
  const params = new URLSearchParams(url.slice(query + 1))
  const rawWindow = params.get('window')
  const rawRepo = params.get('repo')
  const windowId = rawWindow !== null && /^[1-9]\d{0,8}$/.test(rawWindow) ? Number(rawWindow) : null
  const repoPath =
    rawRepo !== null && rawRepo.length > 0 && rawRepo.length <= MAX_REPO_PATH && !rawRepo.includes('\0')
      ? rawRepo
      : null
  if (windowId === null && repoPath === null) return null
  return { windowId, repoPath }
}

/**
 * The window to attach to, or null when there is none.
 *
 * In order: the requested window, if it still has the requested repo; else any
 * window with that repo, the focused one first; else the rule a phone had
 * before it could ask — the focused window if it has a repo, the first window
 * with one, the first window at all.
 */
export function chooseAttachWindow(
  candidates: readonly WindowCandidate[],
  request: AttachRequest | null,
): number | null {
  const withRepo = candidates.filter((c) => c.repoPath !== null)
  if (request) {
    const exact = withRepo.find(
      (c) => c.windowId === request.windowId && (request.repoPath === null || c.repoPath === request.repoPath),
    )
    if (exact) return exact.windowId
    if (request.repoPath !== null) {
      const sameRepo = withRepo.filter((c) => c.repoPath === request.repoPath)
      const pick = sameRepo.find((c) => c.focused) ?? sameRepo[0]
      if (pick) return pick.windowId
    }
  }
  const chosen = withRepo.find((c) => c.focused) ?? withRepo[0] ?? candidates[0]
  return chosen?.windowId ?? null
}

/** The windows a phone can switch to: those with a repo, in window order. */
export function projectsOf(candidates: readonly WindowCandidate[]): RemoteProject[] {
  const out: RemoteProject[] = []
  for (const c of candidates) {
    if (c.repoPath === null) continue
    out.push({
      windowId: c.windowId,
      repoPath: c.repoPath,
      name: basename(c.repoPath).replace(/\.git$/, ''),
      focused: c.focused,
    })
  }
  return out
}
