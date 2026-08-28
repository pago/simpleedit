import { describe, it, expect, vi } from 'vitest'
import {
  blockerMessage,
  decodeVapidKey,
  enablePush,
  isInstalled,
  PushCancelled,
  pushCapability,
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
    expect(blockerMessage(capability)).toMatch(/Tailscale Serve/)
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

  it('persists the subscription and never sends the private half of anything', async () => {
    harness()
    const invoke = vi.fn(() => Promise.resolve(OK))
    await enablePush(KEY, invoke, { label: 'iPhone' })
    expect(invoke).toHaveBeenCalledWith({
      endpoint: 'https://web.push.apple.com/abc',
      keys: { p256dh: 'p', auth: 'a' },
      label: 'iPhone',
    })
    vi.unstubAllGlobals()
  })

  it('unsubscribes when cancelled after the subscription exists', async () => {
    const { unsubscribe } = harness()
    const controller = new AbortController()
    const invoke = vi.fn(() => {
      // Cancelled while the call to main is in flight — the hardest case,
      // because main now has a row too.
      controller.abort()
      return Promise.resolve(OK)
    })
    await expect(enablePush(KEY, invoke, { signal: controller.signal })).rejects.toBeInstanceOf(PushCancelled)
    expect(unsubscribe).toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('unsubscribes when main refuses the subscription', async () => {
    const { unsubscribe } = harness()
    await expect(
      enablePush(KEY, () => Promise.reject(new Error('nope'))),
    ).rejects.toThrow('nope')
    expect(unsubscribe).toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('leaves nothing behind when permission is refused', async () => {
    const { unsubscribe, registration } = harness({ permission: 'denied' })
    const invoke = vi.fn(() => Promise.resolve(OK))
    await expect(enablePush(KEY, invoke)).rejects.toThrow(/not allowed/)
    expect(registration.pushManager.subscribe).not.toHaveBeenCalled()
    expect(unsubscribe).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalled()
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
    await expect(enablePush(KEY, () => Promise.resolve(OK))).rejects.toThrow(/without keys/)
    expect(unsubscribe).toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
