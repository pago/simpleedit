/**
 * `wt-asset:` protocol — serves local files (e.g. images referenced relatively
 * from a Markdown file) to the renderer.
 *
 * A bare `file://` <img> only works in the packaged build (file:// page); in
 * dev the renderer is served over http://localhost and the default webSecurity
 * blocks file:// subresources. This custom scheme works in both, and the
 * handler constrains every request to within a known worktree root so crafted
 * markdown can't read arbitrary files via `../` escapes.
 */
import { protocol, net } from 'electron'
import { resolve, sep } from 'path'
import { pathToFileURL } from 'url'
import { realpathSync } from 'fs'

export const ASSET_SCHEME = 'wt-asset'

/**
 * Return the canonical path to serve, or null if `requested` resolves outside
 * every allowed root. Symlinks are resolved so a link can't escape the root.
 */
export function resolveAssetPath(requested: string, allowedRoots: string[]): string | null {
  let real: string
  try {
    real = realpathSync.native(resolve(requested))
  } catch {
    return null
  }
  for (const root of allowedRoots) {
    let realRoot: string
    try {
      realRoot = realpathSync.native(resolve(root))
    } catch {
      continue
    }
    if (real === realRoot || real.startsWith(realRoot + sep)) return real
  }
  return null
}

/** Register the privileged scheme. Must run before `app.whenReady()`. */
export function registerAssetProtocolScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ASSET_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true },
    },
  ])
}

/** Install the request handler. Run after `app.whenReady()`. */
export function installAssetProtocolHandler(getAllowedRoots: () => string[]): void {
  protocol.handle(ASSET_SCHEME, async (request) => {
    const requested = decodeURIComponent(new URL(request.url).pathname)
    const served = resolveAssetPath(requested, getAllowedRoots())
    if (!served) return new Response(null, { status: 403 })
    return net.fetch(pathToFileURL(served).toString())
  })
}
