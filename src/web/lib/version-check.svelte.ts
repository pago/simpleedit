/**
 * The phone's side of the build check: what each `hello` and each return to
 * the screen do with `decideReload`'s answer, and the banner + confirm state.
 */
import { decideReload, markReloadFor, readReloadMarker, type StorageSource } from './version-reload'

export interface VersionCheckDeps {
  /** The build this page was loaded from (`loadedBuildId`). */
  loaded: string | null
  /** What a reload would throw away; empty when nothing. */
  discards: () => string[]
  atRoot: () => boolean
  visible: () => boolean
  /** Perform the reload. */
  reload: () => void
  storage?: StorageSource
}

export class VersionCheck {
  /** The newer build the Mac reported, while this page has not reloaded for it: the banner. */
  newer = $state<string | null>(null)
  /** The discard confirm is up. */
  confirming = $state(false)
  readonly #deps: VersionCheckDeps

  constructor(deps: VersionCheckDeps) {
    this.#deps = deps
  }

  /** Every `hello`, so a reconnect, a rescan and a project switch all check. */
  hello(server: string | undefined): void {
    const { loaded, discards, atRoot, visible, reload, storage } = this.#deps
    const action = decideReload({
      loaded,
      server,
      visible: visible(),
      atRoot: atRoot(),
      atRisk: discards().length > 0,
      reloadedFor: readReloadMarker(storage),
    })
    if (action === 'none' || !server) {
      this.newer = null
      this.confirming = false
      return
    }
    // Unrecorded, an automatic reload could repeat forever.
    if (action === 'reload' && markReloadFor(server, storage)) {
      reload()
      return
    }
    this.newer = server
  }

  /** The page came back on screen: a reload it deferred may be safe now. */
  shown(): void {
    if (this.newer && this.#deps.visible()) this.hello(this.newer)
  }

  /** The banner's Reload: the tap is consent, unless it would throw something away. */
  request(): void {
    if (!this.newer) return
    if (this.#deps.discards().length > 0) this.confirming = true
    else this.#reloadNow()
  }

  keep(): void {
    this.confirming = false
  }

  discard(): void {
    this.confirming = false
    if (this.newer) this.#reloadNow()
  }

  #reloadNow(): void {
    if (this.newer) markReloadFor(this.newer, this.#deps.storage)
    this.#deps.reload()
  }
}
