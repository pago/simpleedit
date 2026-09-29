/**
 * Client identity for main→renderer pushes.
 *
 * Main keys almost everything by `webContents.id`: the per-window repo maps
 * (`index.ts`), the editor and worktree watchers, and the MCP bridge. A second
 * client attached to the same session (a remote/web client) must therefore
 * JOIN an existing window's identity rather than mint a new one — a new id
 * would resolve to no repo, no bridge and no watcher subscriptions.
 *
 * `ClientHub` is that identity: one id, N transports. Modules that only push
 * events keep taking a single object and stay unaware of the fan-out; they
 * depend on `RemoteClient`, the three-member subset of `WebContents` they
 * actually use, which a real `WebContents` satisfies structurally.
 */

/** The slice of Electron's `WebContents` that event-pushing modules rely on. */
export interface RemoteClient {
  readonly id: number
  /**
   * Identifies this ONE transport, where `id` identifies the hub it belongs
   * to. Absent on a real `WebContents` — which is what keeps the interface
   * structurally satisfied — so callers fall back to the decimal `id`, the
   * key a window's own renderer has always had.
   */
  readonly clientKey?: string
  send(channel: string, data: unknown): void
  /**
   * Fan a channel out with a DIFFERENT payload for socket transports.
   *
   * Present only on a `ClientHub`. A bare `WebContents` doesn't have it —
   * which is what keeps a real `WebContents` structurally satisfying this
   * interface — so callers fall back to `send` with the local payload, which
   * is all a lone window renderer ever received.
   */
  sendSplit?(channel: string, local: unknown, remote: unknown): void
  isDestroyed(): boolean
}

/**
 * One client identity fanning sends out to every attached transport.
 *
 * Destroyed transports are dropped as they are noticed, so a hub whose window
 * has closed reports `isDestroyed()` and its `send` becomes a no-op — matching
 * what a bare `WebContents` did before the indirection.
 */
export class ClientHub implements RemoteClient {
  readonly id: number
  private readonly transports = new Set<RemoteClient>()

  constructor(id: number, initial?: RemoteClient) {
    this.id = id
    if (initial) this.transports.add(initial)
  }

  register(transport: RemoteClient): void {
    this.transports.add(transport)
  }

  unregister(transport: RemoteClient): void {
    this.transports.delete(transport)
  }

  /** Live transports, dropping any that have gone away since the last look. */
  private live(): RemoteClient[] {
    const alive: RemoteClient[] = []
    for (const t of [...this.transports]) {
      if (t.isDestroyed()) this.transports.delete(t)
      else alive.push(t)
    }
    return alive
  }

  send(channel: string, data: unknown): void {
    for (const t of this.live()) t.send(channel, data)
  }

  /**
   * `local` to the window's own renderer, `remote` to every socket transport.
   *
   * A socket transport carries a `clientKey`; a `WebContents` never does — the
   * same discriminator `index.ts` already uses to tell a phone apart from the
   * window it joined. Only for payloads a remote client should receive a
   * cheaper version of; ordinary pushes stay on `send`.
   */
  sendSplit(channel: string, local: unknown, remote: unknown): void {
    for (const t of this.live()) t.send(channel, t.clientKey === undefined ? local : remote)
  }

  /** True once no live transport remains — including before any is attached. */
  isDestroyed(): boolean {
    return this.live().length === 0
  }

  /** Live transport count. Exposed for diagnostics and tests. */
  get transportCount(): number {
    return this.live().length
  }
}
