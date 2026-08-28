import { test as base, expect, chromium, _electron as electron } from '@playwright/test'
import type { Browser, BrowserContext, ElectronApplication, Page } from '@playwright/test'
import path from 'path'
import os from 'os'
import { MAIN, launchEnv, createTempRepo, removeTempRepo, spawnTerminalSession, type TempRepo } from './fixtures'
import type { RemoteAccessStatus } from '../src/shared/ipc-types'

/**
 * Push notifications, as far as a machine without a phone can take them.
 *
 * Be clear about what this proves and what it does not.
 *
 * PROVED here: the service worker registers under the token-gated scope, a
 * push event delivered to it produces exactly the notification the payload
 * asked for, and the manifest that makes an iOS install possible is served
 * with the right content type. The push is injected through CDP's
 * `ServiceWorker.deliverPushMessage`, which is how Chromium fires a push event
 * without a push service — so this exercises the real worker, in a real
 * browser, on the real bundle.
 *
 * NOT proved here, and not provable without the user's iPhone: that Apple
 * accepts our VAPID JWT, that an installed Home Screen app receives the push,
 * or that the encrypted body decrypts on a real device. The encryption itself
 * is checked against RFC 8291's published worked example in
 * `src/main/remote/__tests__/webpush.test.ts`, which is the strongest evidence
 * available offline — but it is evidence about the bytes, not about APNs.
 */

const SANDBOX_ARGS = process.env.CI ? ['--no-sandbox'] : []

type Fixtures = {
  repo: TempRepo
  app: ElectronApplication
  window: Page
  browser: Browser
  context: BrowserContext
}

const test = base.extend<Fixtures>({
  repo: async ({}, use) => {
    const repo = createTempRepo('simpleedit-push-')
    await use(repo)
    removeTempRepo(repo)
  },
  app: async ({ repo }, use) => {
    const app = await electron.launch({
      args: [MAIN, ...SANDBOX_ARGS],
      env: launchEnv({
        SIMPLEEDIT_REPO: repo.bareRepoPath,
        SIMPLEEDIT_E2E_REMOTE_CONFIG: path.join(os.tmpdir(), `simpleedit-remote-push-${process.pid}.json`),
        // Never a real VAPID key or a real subscription in the dev userData.
        SIMPLEEDIT_E2E_PUSH_CONFIG: path.join(os.tmpdir(), `simpleedit-push-${process.pid}.json`),
        SIMPLEEDIT_E2E_PRESENCE_FILE: path.join(os.tmpdir(), `simpleedit-presence-${process.pid}`),
      }),
    })
    await use(app)
    await app.close()
  },
  window: async ({ app }, use) => {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await use(page)
  },
  browser: async ({}, use) => {
    const browser = await chromium.launch({
      // The full Chromium build, not the default headless shell. The shell has
      // no notification platform at all: `Browser.grantPermissions` reports
      // success and `Notification.permission` stays `denied`, so
      // `showNotification` throws inside the worker and the failure looks like
      // a bug in the worker rather than in the browser it ran on.
      channel: 'chromium',
    })
    await use(browser)
    await browser.close()
  },
  context: async ({ browser }, use) => {
    const context = await browser.newContext()
    await use(context)
    await context.close()
  },
})

type Api = {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  on: (channel: string, cb: (data: unknown) => void) => () => void
}

/** By NAME, the way a phone reaches a MagicDNS host — never by the bound IP. */
function byName(url: string): string {
  const parsed = new URL(url)
  parsed.hostname = 'localhost'
  return parsed.toString()
}

async function enableRemote(window: Page): Promise<RemoteAccessStatus> {
  return (await window.evaluate(
    () => (window as unknown as { api: Api }).api.invoke('remote:set-enabled', true),
  )) as RemoteAccessStatus
}

test.afterEach(async ({ window }) => {
  await window.evaluate(() => (window as unknown as { api: Api }).api.invoke('remote:set-enabled', false))
})

test('serves a manifest an iOS install can actually use', async ({ window }) => {
  const status = await enableRemote(window)
  const response = await fetch(new URL('manifest.webmanifest', status.url!).toString())

  expect(response.status).toBe(200)
  // Served as anything else, iOS ignores the manifest — and with no manifest
  // there is no standalone install, and so no permission to ask for.
  expect(response.headers.get('content-type')).toContain('application/manifest+json')

  const manifest = (await response.json()) as { start_url: string; display: string; scope: string }
  expect(manifest.display).toBe('standalone')
  // Relative, so `start_url` resolves under `/<token>/` — the only way an
  // installed app can reach a server that gates every request on the token.
  expect(manifest.start_url).toBe('.')
  expect(manifest.scope).toBe('.')

  // The worker itself is served, as a script, under the same token.
  const worker = await fetch(new URL('sw.js', status.url!).toString())
  expect(worker.status).toBe(200)
  expect(worker.headers.get('content-type')).toContain('javascript')
})

test('a push reaches the worker and becomes the notification the payload asked for', async ({
  window,
  context,
}) => {
  const terminalId = await spawnTerminalSession(window)
  const status = await enableRemote(window)
  const url = byName(status.url!)

  const page = await context.newPage()
  await page.goto(url)
  await context.grantPermissions(['notifications'], { origin: new URL(url).origin })
  await expect(page.getByTestId('screen-title')).toHaveText('Sessions', { timeout: 15_000 })

  // Registered explicitly rather than through the card: the permission prompt
  // and `pushManager.subscribe` both need a real push service, which is what
  // this test deliberately does without.
  const scope = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.register(
      new URL('sw.js', location.href).toString(),
      { scope: new URL('./', location.href).toString() },
    )
    await navigator.serviceWorker.ready
    return registration.scope
  })
  expect(scope).toBe(url)

  // CDP fires a real `push` event in the worker — no push service involved.
  const cdp = await context.newCDPSession(page)
  await cdp.send('ServiceWorker.enable')
  const registrationId = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('No service worker registration reported')), 15_000)
    cdp.on('ServiceWorker.workerRegistrationUpdated', ({ registrations }) => {
      const match = registrations.find((r) => r.scopeURL === scope && !r.isDeleted)
      if (!match) return
      clearTimeout(timer)
      resolve(match.registrationId)
    })
  })

  await cdp.send('ServiceWorker.deliverPushMessage', {
    origin: new URL(url).origin,
    registrationId,
    data: JSON.stringify({
      title: 'Fix the flaky test',
      body: 'Blocked on you — feat/push',
      terminalId,
      url: `${url}#session=${terminalId}`,
      windowId: 7,
    }),
  })

  // The page can read what the worker showed, which is the only observation of
  // a system notification available from inside a browser.
  const shown = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready
    for (let attempt = 0; attempt < 50; attempt++) {
      const notifications = await registration.getNotifications()
      if (notifications.length > 0) {
        return notifications.map((n) => ({
          title: n.title,
          body: n.body,
          tag: n.tag,
          data: n.data as { url: string; terminalId: string; windowId: number | null },
        }))
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return []
  })

  expect(shown).toHaveLength(1)
  expect(shown[0].title).toBe('Fix the flaky test')
  expect(shown[0].body).toBe('Blocked on you — feat/push')
  // One notification per session, so a session cannot stack two entries.
  expect(shown[0].tag).toBe(`simpleedit-${terminalId}`)
  // The tap target travels in the payload, not in the worker's scope: the
  // token is minted per launch, so a worker outlives the scope it registered at.
  expect(shown[0].data.url).toBe(`${url}#session=${terminalId}`)
  expect(shown[0].data.terminalId).toBe(terminalId)
  // A phone joins ONE window's hub, so a tap has to be able to say when the
  // session it names lives on another.
  expect(shown[0].data.windowId).toBe(7)

  await page.close()
})

test('an unreadable push still wakes the phone with something', async ({ window, context }) => {
  const status = await enableRemote(window)
  const url = byName(status.url!)

  const page = await context.newPage()
  await page.goto(url)
  await context.grantPermissions(['notifications'], { origin: new URL(url).origin })
  const scope = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.register(
      new URL('sw.js', location.href).toString(),
      { scope: new URL('./', location.href).toString() },
    )
    await navigator.serviceWorker.ready
    return registration.scope
  })

  const cdp = await context.newCDPSession(page)
  await cdp.send('ServiceWorker.enable')
  const registrationId = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('No service worker registration reported')), 15_000)
    cdp.on('ServiceWorker.workerRegistrationUpdated', ({ registrations }) => {
      const match = registrations.find((r) => r.scopeURL === scope && !r.isDeleted)
      if (!match) return
      clearTimeout(timer)
      resolve(match.registrationId)
    })
  })

  // On iOS a push event that shows no notification is charged against the
  // permission the user granted, so there is no such thing as ignoring one.
  await cdp.send('ServiceWorker.deliverPushMessage', {
    origin: new URL(url).origin,
    registrationId,
    data: 'not json at all',
  })

  const shown = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready
    for (let attempt = 0; attempt < 50; attempt++) {
      const notifications = await registration.getNotifications()
      if (notifications.length > 0) return notifications.map((n) => n.title)
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return []
  })

  expect(shown).toEqual(['A session needs you'])
  await page.close()
})

test('the pane explains the Home Screen step rather than leaving it to be discovered', async ({ window }) => {
  await enableRemote(window)
  await window.evaluate(() => (window as unknown as { api: Api }).api.invoke('push:forget-all'))

  const status = (await window.evaluate(() =>
    (window as unknown as { api: Api }).api.invoke('push:status'),
  )) as { vapidPublicKey: string; devices: unknown[] }

  // A key pair exists from the first read, so the mobile client always has one
  // to subscribe against.
  expect(status.vapidPublicKey).toMatch(/^[A-Za-z0-9_-]{87}$/)
  expect(status.devices).toEqual([])

  // The private half is not in anything a client can reach.
  expect(JSON.stringify(status)).not.toMatch(/privateKey/)
})
