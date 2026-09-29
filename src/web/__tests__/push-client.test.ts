import { describe, it, expect, vi } from 'vitest'
import {
  blockerMessage,
  decodeVapidKey,
  disablePush,
  enablePush,
  isInstalled,
  PushCancelled,
  pushCapability,
  subscriptionState,
} from '../lib/push-client'
import type { PushStatus } from '../../shared/ipc-types'

/**
 * The browser half, driven against fakes rather than a real push service —
 * Chromium's `pushManager.subscribe` talks to Google, which is neither
 * available offline nor something a test should depend on. What IS testable
 * here is every decision around it: whether we may ask at all, what we tell
 * the user when we may not, and — the one that matters — what happens to a
 * live subscription when the user changes their mind halfway.
 */

const OK: PushStatus = { vapidPublicKey: 'k', devices: [], error: null }

/** A window with exactly the capabilities named, and nothing else. */
function fakeWindow(options: {
  secure?: boolean
  serviceWorker?: boolean
  pushManager?: boolean
  notification?: NotificationPermission | false
  standalone?: boolean
  displayMode?: boolean
}): Window {
  const nav: Record<string, unknown> = { standalone: options.standalone }
  if (options.serviceWorker) nav.serviceWorker = {}
  const win: Record<string, unknown> = {
    isSecureContext: options.secure ?? true,
    navigator: nav,
    matchMedia: () => ({ matches: options.displayMode === true }),
  }
  if (options.pushManager) win.PushManager = class {}
  if (options.notification) win.Notification = { permission: options.notification }
  return win as unknown as Window
}

describe('isInstalled', () => {
  it('recognises an iOS Home Screen app', () => {
    expect(isInstalled(fakeWindow({ standalone: true }))).toBe(true)
  })

  it('recognises a standalone display mode', () => {
    expect(isInstalled(fakeWindow({ displayMode: true }))).toBe(true)
  })

  it('is false in an ordinary tab', () => {
    expect(isInstalled(fakeWindow({}))).toBe(false)
  })
})

describe('pushCapability', () => {
  /**
   * The decision the plan says must be explained rather than discovered: on
   * iOS the push APIs are simply absent until the page is on the Home Screen,
   * so "unsupported" would be the wrong thing to tell someone holding an
   * iPhone that can do this perfectly well once installed.
   */
  it('asks for a Home Screen install when the APIs are missing in a tab', () => {
    const capability = pushCapability(fakeWindow({ standalone: false }))
    expect(capability.blocker).toBe('needs-install')
    expect(blockerMessage(capability)).toMatch(/Add this page to your Home Screen/)
  })

  it('says unsupported only once installed and still missing the APIs', () => {
    expect(pushCapability(fakeWindow({ standalone: true })).blocker).toBe('unsupported')
  })

  /**
   * Ordered by what the user would have to do: telling someone to install the
   * page is useless when the URL is not a secure context, because the
   * installed copy will not be one either.
   */
  it('reports an insecure context before anything else', () => {
    const capability = pushCapability(
      fakeWindow({ secure: false, serviceWorker: true, pushManager: true, notification: 'default' }),
    )
    expect(capability.blocker).toBe('insecure-context')
    // Points at the pane rather than naming one fix: a node can hold HTTPS
    // certificates while tailscaled is stopped, and Serve is not the answer then.
    expect(blockerMessage(capability)).toMatch(/Settings → Remote access/)
    expect(blockerMessage(capability)).not.toMatch(/Turn on Tailscale Serve/)
  })

  it('reports a denial the user has to undo in device settings', () => {
    const capability = pushCapability(
      fakeWindow({ serviceWorker: true, pushManager: true, notification: 'denied', standalone: true }),
    )
    expect(capability.blocker).toBe('denied')
    expect(blockerMessage(capability)).toMatch(/device settings/)
  })

  it('clears the way when everything is in place', () => {
    const capability = pushCapability(
      fakeWindow({ serviceWorker: true, pushManager: true, notification: 'default', standalone: true }),
    )
    expect(capability.blocker).toBeNull()
    expect(blockerMessage(capability)).toBeNull()
  })
})

describe('decodeVapidKey', () => {
  it('turns base64url into the raw bytes `applicationServerKey` wants', () => {
    // 'BQ' + 63 more bytes is what a real key looks like; any round trip proves
    // the -_ / +/ substitution and the padding.
    const bytes = decodeVapidKey('AQIDBP__')
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4, 255, 255])
  })
})

describe('enablePush — the window nobody owns', () => {
  const KEY = 'AQIDBA'

  /**
   * `getUserMedia` taught this lesson in phase 4 and push repeats it exactly:
   * between the user granting permission and the subscription reaching main
   * there are three awaits, and a real resource — a subscription registered
   * with Apple — exists partway through. If nothing can cancel it, that window
   * is a leak that survives the user changing their mind.
   */
  function harness(options: { permission?: NotificationPermission } = {}) {
    const unsubscribe = vi.fn(() => Promise.resolve(true))
    const subscription = {
      endpoint: 'https://web.push.apple.com/abc',
      toJSON: () => ({ endpoint: 'https://web.push.apple.com/abc', keys: { p256dh: 'p', auth: 'a' } }),
      unsubscribe,
    }
    const registration = { pushManager: { subscribe: vi.fn(() => Promise.resolve(subscription)) } }

    vi.stubGlobal('Notification', {
      requestPermission: () => Promise.resolve(options.permission ?? 'granted'),
    })
    vi.stubGlobal('navigator', {
      serviceWorker: {
        getRegistrations: () => Promise.resolve([]),
        register: () => Promise.resolve(registration),
      },
    })
    return { unsubscribe, subscription, registration }
  }

  const noRemove = vi.fn(() => Promise.resolve(OK))

  it('persists the subscription and never sends the private half of anything', async () => {
    harness()
    const invoke = vi.fn(() => Promise.resolve(OK))
    await enablePush(KEY, invoke, { label: 'iPhone', remove: noRemove })
    expect(invoke).toHaveBeenCalledWith({
      endpoint: 'https://web.push.apple.com/abc',
      keys: { p256dh: 'p', auth: 'a' },
      label: 'iPhone',
    })
    vi.unstubAllGlobals()
  })

  /**
   * The hardest case, and the one an earlier version got wrong: main already
   * holds the row. Unsubscribing locally alone would leave the Mac pushing at a
   * dead endpoint until the service answered 410, and the pane listing a device
   * that is not registered — while the header claimed nothing half-registered
   * survives.
   */
  it('undoes BOTH halves when cancelled after the subscribe reached main', async () => {
    const { unsubscribe } = harness()
    const controller = new AbortController()
    const remove = vi.fn(() => Promise.resolve(OK))
    const invoke = vi.fn(() => {
      controller.abort()
      return Promise.resolve(OK)
    })
    await expect(
      enablePush(KEY, invoke, { signal: controller.signal, remove }),
    ).rejects.toBeInstanceOf(PushCancelled)
    expect(unsubscribe).toHaveBeenCalled()
    expect(remove).toHaveBeenCalledWith('https://web.push.apple.com/abc')
    vi.unstubAllGlobals()
  })

  it('does not ask main to remove a row it never created', async () => {
    const { unsubscribe } = harness()
    const remove = vi.fn(() => Promise.resolve(OK))
    await expect(
      enablePush(KEY, () => Promise.reject(new Error('nope')), { remove }),
    ).rejects.toThrow('nope')
    expect(unsubscribe).toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('leaves nothing behind when permission is refused', async () => {
    const { unsubscribe, registration } = harness({ permission: 'denied' })
    const invoke = vi.fn(() => Promise.resolve(OK))
    const remove = vi.fn(() => Promise.resolve(OK))
    await expect(enablePush(KEY, invoke, { remove })).rejects.toThrow(/not allowed/)
    expect(registration.pushManager.subscribe).not.toHaveBeenCalled()
    expect(unsubscribe).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('refuses a subscription the browser produced without keys', async () => {
    const { unsubscribe } = harness()
    vi.stubGlobal('navigator', {
      serviceWorker: {
        getRegistrations: () => Promise.resolve([]),
        register: () =>
          Promise.resolve({
            pushManager: {
              subscribe: () =>
                Promise.resolve({ endpoint: 'https://x.test/a', toJSON: () => ({ endpoint: 'https://x.test/a' }), unsubscribe }),
            },
          }),
      },
    })
    await expect(enablePush(KEY, () => Promise.resolve(OK), { remove: noRemove })).rejects.toThrow(
      /without keys/,
    )
    expect(unsubscribe).toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})

/**
 * Whether the enable control is offered at all.
 *
 * The browser's own answer is half the question, and taking it as the whole
 * one is what hid the control forever: a subscription outlives the Mac's
 * record of it whenever the user taps Forget, the push service disowns the
 * endpoint, or a corrupt VAPID pair is replaced.
 */
describe('subscriptionState', () => {
  function withSubscription(endpoint: string | null): void {
    vi.stubGlobal('navigator', {
      serviceWorker: {
        getRegistration: () =>
          Promise.resolve({
            pushManager: { getSubscription: () => Promise.resolve(endpoint ? { endpoint } : null) },
          }),
      },
    })
  }

  it('is inactive when this browser holds nothing', async () => {
    withSubscription(null)
    expect(await subscriptionState(() => Promise.resolve('id'))).toEqual({
      local: false,
      remote: false,
      active: false,
      orphaned: false,
    })
    vi.unstubAllGlobals()
  })

  it('is active when both halves agree', async () => {
    withSubscription('https://x.test/a')
    const state = await subscriptionState(() => Promise.resolve('abc123'))
    expect(state.active).toBe(true)
    expect(state.orphaned).toBe(false)
    vi.unstubAllGlobals()
  })

  it('is ORPHANED when the Mac has forgotten this device — the state with no way back', async () => {
    withSubscription('https://x.test/a')
    const state = await subscriptionState(() => Promise.resolve(null))
    expect(state).toEqual({ local: true, remote: false, active: false, orphaned: true })
    vi.unstubAllGlobals()
  })

  /**
   * A dropped socket is not the Mac forgetting you. Reading it that way would
   * tell the user to re-register over a connection that cannot carry it.
   */
  it('treats an unreachable Mac as still registered, not as forgotten', async () => {
    withSubscription('https://x.test/a')
    const state = await subscriptionState(() => Promise.reject(new Error('Connection lost')))
    expect(state.active).toBe(true)
    expect(state.orphaned).toBe(false)
    vi.unstubAllGlobals()
  })
})

describe('disablePush', () => {
  it('tells the Mac BEFORE destroying the endpoint that names the row', async () => {
    const order: string[] = []
    const unsubscribe = vi.fn(() => {
      order.push('unsubscribe')
      return Promise.resolve(true)
    })
    vi.stubGlobal('navigator', {
      serviceWorker: {
        getRegistration: () =>
          Promise.resolve({
            pushManager: {
              getSubscription: () =>
                Promise.resolve({ endpoint: 'https://x.test/a', unsubscribe }),
            },
          }),
      },
    })
    await disablePush((endpoint) => {
      order.push(`invoke:${endpoint}`)
      return Promise.resolve(OK)
    })
    expect(order).toEqual(['invoke:https://x.test/a', 'unsubscribe'])
    vi.unstubAllGlobals()
  })

  it('is a no-op when there is nothing to disable', async () => {
    vi.stubGlobal('navigator', {
      serviceWorker: {
        getRegistration: () =>
          Promise.resolve({ pushManager: { getSubscription: () => Promise.resolve(null) } }),
      },
    })
    const invoke = vi.fn(() => Promise.resolve(OK))
    expect(await disablePush(invoke)).toBeNull()
    expect(invoke).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
