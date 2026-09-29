/**
 * The service worker: receive a push, show it, and on a tap land in the
 * session that blocked.
 *
 * Deliberately a shell. Every decision it makes lives in `lib/push-payload.ts`
 * where it can be tested; a service worker's own scope cannot be entered by a
 * test, so anything with a judgement call in it does not belong here.
 *
 * Three things this worker does NOT do, each on purpose:
 *
 *  - **It caches nothing.** The page is served from a token-gated origin whose
 *    token is minted per launch, so a cached shell would be a stale one behind
 *    a URL that no longer resolves. Offline is not a use case: without the Mac
 *    there is nothing to show.
 *  - **It never touches the microphone.** iOS requires a user gesture, and a
 *    hot mic on wake would be wrong even where it is permitted.
 *  - **It never navigates an existing tab.** That reloads it, throwing away
 *    the live socket, the xterm buffer and any half-typed reply. It messages
 *    the tab instead and lets the app move itself.
 */
/// <reference lib="webworker" />
import { planClick, planNotification } from './lib/push-payload'

declare const self: ServiceWorkerGlobalScope

/**
 * `renotify` is part of the Notifications API but missing from this
 * TypeScript release's `NotificationOptions`. Named here rather than cast
 * away, so the value we pass stays type-checked against something.
 */
interface TaggedNotificationOptions extends NotificationOptions {
  renotify?: boolean
}

// Take over without waiting for every old tab to close. A worker that only
// activates on the next cold start is a worker that misses the notification
// the user just enabled.
self.addEventListener('install', () => {
  void self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('push', (event) => {
  const plan = planNotification(event.data?.text(), self.registration.scope)
  // `waitUntil` is not optional: without it the worker may be killed before
  // the notification is shown, and on iOS a push event that shows nothing
  // counts against the permission the user just granted.
  const options: TaggedNotificationOptions = {
    body: plan.body,
    tag: plan.tag,
    renotify: plan.renotify,
    data: { url: plan.url, terminalId: plan.terminalId, windowId: plan.windowId },
  }
  event.waitUntil(self.registration.showNotification(plan.title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const data = (event.notification.data ?? {}) as {
    url?: string
    terminalId?: string
    windowId?: number | null
  }
  const url = data.url ?? self.registration.scope
  const terminalId = data.terminalId ?? ''
  const windowId = typeof data.windowId === 'number' ? data.windowId : null

  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const action = planClick(url, terminalId, [...clients], windowId)
      if (action.kind === 'open') {
        await self.clients.openWindow(action.url)
        return
      }
      const target = clients[action.clientIndex]
      // Focus first: on iOS the window-focus grant expires quickly, and a
      // message posted to an unfocused client leaves the user staring at a
      // notification that appeared to do nothing.
      await target.focus()
      target.postMessage(action.message)
    })(),
  )
})
