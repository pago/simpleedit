/**
 * A registry in front of `ipcMain`, so a transport that is not an Electron IPC
 * channel can reach the same handlers.
 *
 * The remote server (`remote/server.ts`) carries `window.api` calls over a
 * WebSocket. Those must land in the SAME handler the renderer's `invoke`
 * reaches — a parallel dispatch table would be a second implementation of
 * every channel, free to drift, and the security surface would then depend on
 * which door a call came through. `ipcMain` keeps its handler map private, so
 * registration goes through here and keeps a copy.
 *
 * The only thing a remote call substitutes is the event's `sender`: a
 * `RemoteClient` carrying the window id it joined (so the per-window repo
 * maps, watchers and bridge all resolve as usual) and its own `clientKey`
 * (so PTY size ownership can still tell the two transports apart).
 */
import { ipcMain } from 'electron'
import type { RemoteClient } from './client-hub'

/** The slice of `IpcMainInvokeEvent` that handlers in this app actually read. */
export interface CallOrigin {
  readonly sender: RemoteClient
}

/**
 * `never[]` rest args make every concretely-typed handler assignable here
 * (parameters are checked contravariantly, and `never` is assignable to
 * anything) without reaching for `any`. The event stays `CallOrigin` so
 * handler bodies still get it inferred.
 */
type Listener = (event: CallOrigin, ...args: never[]) => unknown

/** What the registry stores: the same function, seen through the call site. */
type StoredListener = (event: CallOrigin, ...args: unknown[]) => unknown

const invokeHandlers = new Map<string, StoredListener>()
const sendHandlers = new Map<string, StoredListener>()

/** Register an `invoke` handler with both `ipcMain` and the remote dispatcher. */
export function handleInvoke(channel: string, listener: Listener): void {
  invokeHandlers.set(channel, listener as unknown as StoredListener)
  // The casts are the one place the three views of a handler meet: ours, the
  // registry's, and `ipcMain`'s `any`-typed one. Nothing is lost that was ever
  // checked — `CallOrigin` is a structural subset of `IpcMainInvokeEvent`.
  ipcMain.handle(channel, listener as unknown as Parameters<typeof ipcMain.handle>[1])
}

/** Register a fire-and-forget `send` handler with both. */
export function handleSend(channel: string, listener: Listener): void {
  sendHandlers.set(channel, listener as unknown as StoredListener)
  ipcMain.on(channel, listener as unknown as Parameters<typeof ipcMain.on>[1])
}

export function hasInvokeHandler(channel: string): boolean {
  return invokeHandlers.has(channel)
}

/**
 * Run a registered `invoke` handler on behalf of a non-IPC transport.
 *
 * Throws `Unknown channel` for anything unregistered — a remote client can
 * name any string, and an unrecognised one must fail loudly rather than
 * resolve to `undefined` and look like a successful call that did nothing.
 */
export async function dispatchInvoke(
  channel: string,
  origin: CallOrigin,
  args: unknown[],
): Promise<unknown> {
  const handler = invokeHandlers.get(channel)
  if (!handler) throw new Error(`Unknown channel: ${channel}`)
  return await handler(origin, ...args)
}

/** Run a registered `send` handler on behalf of a non-IPC transport. */
export function dispatchSend(channel: string, origin: CallOrigin, args: unknown[]): void {
  const handler = sendHandlers.get(channel)
  if (!handler) throw new Error(`Unknown channel: ${channel}`)
  handler(origin, ...args)
}
