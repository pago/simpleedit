/**
 * Turning notifications on, from the browser side.
 *
 * ── The iOS constraint, which shapes everything here ──────────────────────
 * Safari will not let a page request notification permission unless it has
 * been added to the Home Screen. Not "it works badly" — the API is absent, so
 * a page that assumes otherwise throws on a tap and looks broken. That is why
 * `pushCapability()` reports WHY it cannot subscribe rather than a boolean:
 * "add this to your Home Screen first" is an instruction, and no user is going
 * to derive it from a disabled button.
 *
 * ── The window nobody owns ────────────────────────────────────────────────
 * Between the user granting permission and the subscription reaching main
 * there are three awaits, and the phase-4 lesson applies exactly: the resource
 * (a live push subscription registered with Apple) exists partway through, and
 * something has to be able to cancel it. So `enablePush` takes a signal, and
 * on ANY exit path where the subscription was created but not persisted it
 * unsubscribes — including the early returns. Nothing half-registered survives
 * the user changing their mind, and nothing survives a restart.
 */
import type { PushStatus } from '../../shared/ipc-types'
import type { OpenSessionMessage } from './push-payload'
import { isOpenSessionMessage } from './push-payload'

export type PushBlocker =
  | 'unsupported'
  | 'needs-install'
  | 'insecure-context'
  | 'denied'
  | null

export interface PushCapability {
  /** Null when a subscription can be attempted right now. */
  blocker: PushBlocker
  /** Running from the Home Screen (iOS) or as an installed PWA. */
  installed: boolean
  permission: NotificationPermission | 'unavailable'
}

/** iOS reports an installed PWA through a non-standard property on `navigator`. */
interface IosNavigator extends Navigator {
  standalone?: boolean
}

export function isInstalled(win: Window = window): boolean {
  const nav = win.navigator as IosNavigator
  if (nav.standalone === true) return true
  return win.matchMedia?.('(display-mode: standalone)').matches === true
}

/**
 * What, if anything, stands between the user and a notification.
 *
 * Ordered by what they would have to do about it, cheapest first — telling
 * someone to add the page to their Home Screen is useless if the URL is not a
 * secure context, because the installed copy will not be one either.
 */
export function pushCapability(win: Window = window): PushCapability {
  const installed = isInstalled(win)
  if (!win.isSecureContext) {
    return { blocker: 'insecure-context', installed, permission: 'unavailable' }
  }
  if (!('serviceWorker' in win.navigator) || !('PushManager' in win)) {
    // On iOS this is what a Safari TAB looks like: the APIs simply are not
    // there until the page has been installed, so "unsupported" would be a
    // misleading thing to tell someone holding an iPhone.
    return { blocker: installed ? 'unsupported' : 'needs-install', installed, permission: 'unavailable' }
  }
  if (!('Notification' in win)) {
    return { blocker: installed ? 'unsupported' : 'needs-install', installed, permission: 'unavailable' }
  }
  const permission = (win as Window & { Notification: typeof Notification }).Notification.permission
  if (permission === 'denied') return { blocker: 'denied', installed, permission }
  return { blocker: null, installed, permission }
}

export function blockerMessage(capability: PushCapability): string | null {
  switch (capability.blocker) {
    case 'insecure-context':
      return 'Notifications need an HTTPS address. Turn on Tailscale Serve in Settings → Remote access and reopen this page on the https:// link.'
    case 'needs-install':
      return 'Add this page to your Home Screen first — Share, then “Add to Home Screen” — and open it from there. iOS only allows notifications for an installed app.'
    case 'denied':
      return 'Notifications are blocked for this app. Turn them back on in your device settings, then try again.'
    case 'unsupported':
      return 'This browser cannot receive push notifications.'
    default:
      return null
  }
}

/** RFC 8292 hands out base64url; `applicationServerKey` wants raw bytes. */
export function decodeVapidKey(base64url: string): Uint8Array {
  const padded = base64url.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

/**
 * Register (or re-register) the worker for THIS page's scope, dropping any
 * registration left under another one.
 *
 * The access token is the first path segment and is minted per server launch,
 * so yesterday's worker sits at a scope that no longer resolves — while still
 * holding a live subscription that would buzz alongside the new one. Clearing
 * it is what keeps one block from producing two notifications.
 */
export async function registerWorker(
  scriptUrl = new URL('sw.js', window.location.href).toString(),
  scope = new URL('./', window.location.href).toString(),
): Promise<ServiceWorkerRegistration> {
  for (const existing of await navigator.serviceWorker.getRegistrations()) {
    if (existing.scope !== scope) await existing.unregister()
  }
  return await navigator.serviceWorker.register(scriptUrl, { scope })
}

export interface EnablePushOptions {
  /**
   * Aborts the whole operation. Anything already created by the time it fires
   * is torn down — that is the point of taking one at all.
   */
  signal?: AbortSignal
  /** How the device lists itself in the Remote access pane. */
  label?: string
}

export class PushCancelled extends Error {
  constructor() {
    super('Cancelled')
    this.name = 'PushCancelled'
  }
}

/**
 * Permission → worker → subscription → persisted, cancellable throughout.
 *
 * Called only from a user gesture. Requesting permission on load is what
 * trains people to deny it, and on iOS it is refused outright.
 */
export async function enablePush(
  vapidPublicKey: string,
  invoke: (subscription: { endpoint: string; keys: { p256dh: string; auth: string }; label?: string }) => Promise<PushStatus>,
  options: EnablePushOptions = {},
): Promise<PushStatus> {
  const { signal } = options
  const cancelled = (): boolean => signal?.aborted === true

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') throw new Error('Notifications were not allowed')
  if (cancelled()) throw new PushCancelled()

  const registration = await registerWorker()
  if (cancelled()) throw new PushCancelled()

  // From here on a real resource exists at Apple, so every exit path has to
  // release it. `subscribe` is idempotent for the same key, so re-running
  // after a cancel is safe.
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: decodeVapidKey(vapidPublicKey) as BufferSource,
  })

  try {
    if (cancelled()) throw new PushCancelled()
    const json = subscription.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } }
    if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) {
      throw new Error('The browser produced a subscription without keys')
    }
    const status = await invoke({
      endpoint: json.endpoint,
      keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
      label: options.label,
    })
    // Cancelled while the invoke was in flight: main has it, so the undo is a
    // real unsubscribe AND a real removal, not just dropping the handle.
    if (cancelled()) {
      await subscription.unsubscribe().catch(() => undefined)
      throw new PushCancelled()
    }
    return status
  } catch (error) {
    await subscription.unsubscribe().catch(() => undefined)
    throw error
  }
}

/** Drop this device's subscription, locally and on the Mac. */
export async function disablePush(
  invoke: (endpoint: string) => Promise<PushStatus>,
): Promise<PushStatus | null> {
  const registration = await navigator.serviceWorker.getRegistration()
  const subscription = await registration?.pushManager.getSubscription()
  if (!subscription) return null
  const { endpoint } = subscription
  await subscription.unsubscribe().catch(() => undefined)
  return await invoke(endpoint)
}

/** Whether this browser already holds a subscription. */
export async function hasSubscription(): Promise<boolean> {
  if (!('serviceWorker' in navigator)) return false
  const registration = await navigator.serviceWorker.getRegistration()
  return (await registration?.pushManager.getSubscription()) != null
}

/**
 * A tap on a notification, arriving in an already-open tab.
 *
 * The worker messages rather than navigates, so this is the only path by which
 * a tap can move the app — and it must never do anything but move it. No
 * microphone, no sending.
 */
export function onOpenSession(handler: (message: OpenSessionMessage) => void): () => void {
  if (!('serviceWorker' in navigator)) return () => undefined
  const listener = (event: MessageEvent): void => {
    if (isOpenSessionMessage(event.data)) handler(event.data)
  }
  navigator.serviceWorker.addEventListener('message', listener)
  return () => navigator.serviceWorker.removeEventListener('message', listener)
}
