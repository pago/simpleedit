import { test as base, expect, chromium, _electron as electron } from '@playwright/test'
import type { Browser, ElectronApplication, Page } from '@playwright/test'
import path from 'path'
import os from 'os'
import {
  MAIN,
  launchEnv,
  createTempRepo,
  removeTempRepo,
  spawnTerminalSession,
  measurePtySize,
  awaitPtySize,
  type TempRepo,
} from './fixtures'
import type { RemoteAccessStatus } from '../src/shared/ipc-types'

/**
 * The remote surface, proved from an ordinary browser — no phone, no Tailscale.
 *
 * `http://localhost` is a secure context, so verifying here is not a weaker
 * substitute for the real thing: it exercises the same server, the same token
 * gate, the same hub registration and the same `window.api` shim the phone
 * will use. Only the TLS in front of it differs.
 */

const SANDBOX_ARGS = process.env.CI ? ['--no-sandbox'] : []

type Fixtures = {
  repo: TempRepo
  app: ElectronApplication
  window: Page
  browser: Browser
}

const test = base.extend<Fixtures>({
  repo: async ({}, use) => {
    const repo = createTempRepo('simpleedit-remote-')
    await use(repo)
    removeTempRepo(repo)
  },
  app: async ({ repo }, use) => {
    const app = await electron.launch({
      args: [MAIN, ...SANDBOX_ARGS],
      env: launchEnv({
        SIMPLEEDIT_REPO: repo.bareRepoPath,
        // Keep the toggle out of the dev build's real userData.
        SIMPLEEDIT_E2E_REMOTE_CONFIG: path.join(os.tmpdir(), `simpleedit-remote-${process.pid}.json`),
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
    const browser = await chromium.launch()
    await use(browser)
    await browser.close()
  },
})

type Api = {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  on: (channel: string, cb: (data: unknown) => void) => () => void
}

/**
 * The same URL reached by NAME rather than by the bound IP — what a phone does
 * with a MagicDNS name, and what `status.url` never exercises.
 */
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

test('serves the web bundle only under its token, and holds a power assertion', async ({ window }) => {
  const status = await enableRemote(window)

  expect(status.running).toBe(true)
  expect(status.host).toBe('127.0.0.1')
  expect(status.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{64}\/$/)
  // Without this the Mac sleeps and the agents stop, silently.
  expect(status.powerSaveBlocked).toBe(true)

  const origin = new URL(status.url!).origin
  expect((await fetch(`${origin}/`)).status).toBe(404)
  expect((await fetch(`${origin}/${'a'.repeat(64)}/`)).status).toBe(404)

  const served = await fetch(status.url!)
  expect(served.status).toBe(200)
  expect(await served.text()).toContain('SimpleEdit')
})

test('lists the window\'s sessions and opens one on the real PTY', async ({ window, browser }) => {
  const terminalId = await spawnTerminalSession(window)
  const status = await enableRemote(window)

  const page = await browser.newPage()
  await page.goto(byName(status.url!))

  // Top-level chrome: a title and a tab bar, never a segmented control.
  await expect(page.getByTestId('screen-title')).toHaveText('Sessions', { timeout: 15_000 })
  await expect(page.getByTestId('tab-bar')).toBeVisible()
  await expect(page.getByTestId('connection-dot')).toHaveAttribute('data-state', 'open')

  // The list is the window's own, pushed by the renderer that owns it.
  const row = page.locator(`[data-testid="session-row"][data-session-id="${terminalId}"]`)
  await expect(row).toBeVisible({ timeout: 15_000 })

  // Detail chrome: a back button, and the tab bar gone.
  await row.click()
  await expect(page.getByTestId('back')).toBeVisible()
  await expect(page.getByTestId('tab-bar')).toHaveCount(0)
  await expect(page.getByTestId('mobile-terminal')).toBeVisible()

  // A real terminal: the shell's own output, replayed from main's backlog.
  await expect(page.locator('.xterm-rows')).toContainText(/\S/, { timeout: 15_000 })

  await page.getByTestId('back').click()
  await expect(page.getByTestId('screen-title')).toHaveText('Sessions')

  await page.close()
})

test('opening a session claims the PTY, and the desktop is told', async ({ window, browser }) => {
  const terminalId = await spawnTerminalSession(window)
  const status = await enableRemote(window)

  const desktopHeard = window.evaluate(
    (id) =>
      new Promise<string | null>((resolve) => {
        const off = (window as unknown as { api: Api }).api.on('pty:owner-changed', (data) => {
          const payload = data as { id: string; owner: string | null }
          if (payload.id !== id) return
          off()
          resolve(payload.owner)
        })
      }),
    terminalId,
  )

  const page = await browser.newPage()
  await page.goto(byName(status.url!))
  await page.locator(`[data-testid="session-row"][data-session-id="${terminalId}"]`).click()

  // The desktop window learns it lost the size — main is authoritative, and it
  // says so instead of silently dropping that window's resizes.
  expect(await desktopHeard).toMatch(/^w\d+\./)

  await page.close()
})

// A phone locks its screen and its socket goes. Nothing else notices — a PTY
// outlives every client, and `pty:claim` fires only on an attention CHANGE, so
// a desktop window already sitting on the terminal never reclaims. Without the
// release, that window's resizes are dropped for the terminal's whole life.
test('a socket that goes releases the terminal size it was holding', async ({ window, browser }) => {
  const terminalId = await spawnTerminalSession(window)
  const status = await enableRemote(window)

  // Collect every announcement for this terminal, so the sequence can be read
  // rather than raced: the claim first, then the release.
  await window.evaluate((id) => {
    const owners: (string | null)[] = []
    ;(window as unknown as { __owners__: (string | null)[] }).__owners__ = owners
    ;(window as unknown as { api: Api }).api.on('pty:owner-changed', (data) => {
      const payload = data as { id: string; owner: string | null }
      if (payload.id === id) owners.push(payload.owner)
    })
  }, terminalId)

  const page = await browser.newPage()
  await page.goto(byName(status.url!))
  await page.locator(`[data-testid="session-row"][data-session-id="${terminalId}"]`).click()

  await expect
    .poll(
      async () =>
        await window.evaluate(() => (window as unknown as { __owners__: (string | null)[] }).__owners__),
      { timeout: 15_000 },
    )
    .toEqual([expect.stringMatching(/^w\d+\./)])

  await page.close()

  // Announced as unowned, so the desktop stops saying it lost the size — and
  // main stops dropping its resizes on behalf of a socket that no longer exists.
  await expect
    .poll(
      async () =>
        await window.evaluate(() => (window as unknown as { __owners__: (string | null)[] }).__owners__),
      { timeout: 15_000 },
    )
    .toEqual([expect.stringMatching(/^w\d+\./), null, expect.anything()])
})

// Clearing the banner is not the point; the PTY's geometry is. Ownership moving
// without geometry following is the phase-2 blocker in a new place: the desktop
// would go on drawing a phone-shaped terminal into a desktop-shaped view, with
// no event left to correct it — the ResizeObserver fires only on a container
// change and a claim only on an attention change.
test('a released terminal is resized back to the view that is left', async ({ window, browser }) => {
  const terminalId = await spawnTerminalSession(window)
  const status = await enableRemote(window)

  const desktop = await measurePtySize(window, terminalId)

  // A phone-shaped viewport, so its claim is unmistakably a different geometry.
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  await page.goto(byName(status.url!))
  await page.locator(`[data-testid="session-row"][data-session-id="${terminalId}"]`).click()

  const phone = await awaitPtySize(window, terminalId, (size) => size.cols < desktop.cols)
  expect(phone.cols).toBeLessThan(desktop.cols)

  // The tunnel drops. Nothing on the desktop changed size, and nothing gained
  // or lost focus — so this only recovers if the release itself drives it.
  await page.close()

  const restored = await awaitPtySize(
    window,
    terminalId,
    (size) => size.cols === desktop.cols && size.rows === desktop.rows,
  )
  expect(restored).toEqual(desktop)
})

// Needs no whisper and no model, so it does not belong behind the dictation
// gate — where it never ran on CI at all.
test('the accessory keys reach the PTY', async ({ window, browser }) => {
  const terminalId = await spawnTerminalSession(window)
  const status = await enableRemote(window)

  const page = await browser.newPage()
  await page.goto(byName(status.url!))
  await page.locator(`[data-testid="session-row"][data-session-id="${terminalId}"]`).click()

  await page.getByTestId('composer-text').fill('echo keybar-proof')
  await page.getByTestId('composer-send').click()
  await expect(page.locator('.xterm-rows')).toContainText('keybar-proof', { timeout: 20_000 })

  // Up recalls the previous command; Enter runs it again. Both are the bar's.
  await page.getByTestId('key-up').click()
  await page.getByTestId('key-enter').click()
  await expect
    .poll(
      async () => (await page.locator('.xterm-rows').innerText()).match(/keybar-proof/g)?.length ?? 0,
      { timeout: 20_000 },
    )
    .toBeGreaterThanOrEqual(3)

  await page.close()
})

// The list is per-window state a socket must not be able to write: a socket
// joins an existing hub, so `sender.id` IS the window's id, and the renderer
// re-pushes only when its own state changes — so nothing would put it back.
test('a remote client cannot overwrite the window\'s session list', async ({ window, browser }) => {
  const terminalId = await spawnTerminalSession(window)
  const status = await enableRemote(window)

  const page = await browser.newPage()
  await page.goto(byName(status.url!))
  await expect(page.locator(`[data-testid="session-row"][data-session-id="${terminalId}"]`)).toBeVisible({
    timeout: 15_000,
  })

  const refused = await page.evaluate(async () => {
    try {
      await (window as unknown as { api: Api }).api.invoke('session:sync', [])
      return null
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  })
  expect(refused).toMatch(/not available to remote clients/)

  // And the list is still the window's own.
  const sessions = (await window.evaluate(() =>
    (window as unknown as { api: Api }).api.invoke('session:list'),
  )) as { terminalId: string }[]
  expect(sessions.map((s) => s.terminalId)).toContain(terminalId)

  await page.close()
})

// Turning Serve on publishes this app to every device on the tailnet. A token
// holder already has the machine, but widening what the TAILNET reaches is a
// decision that belongs at the desk, not to whoever holds a link.
test('a remote client cannot switch on Tailscale Serve', async ({ window, browser }) => {
  const status = await enableRemote(window)

  const page = await browser.newPage()
  await page.goto(byName(status.url!))
  await page.waitForFunction(() => 'api' in window, undefined, { timeout: 15_000 })

  const refused = await page.evaluate(async () => {
    try {
      await (window as unknown as { api: Api }).api.invoke('remote:set-serve-enabled', true)
      return null
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  })
  expect(refused).toMatch(/not available to remote clients/)

  const config = (await window.evaluate(() =>
    (window as unknown as { api: Api }).api.invoke('remote:config'),
  )) as { serveEnabled: boolean }
  expect(config.serveEnabled).toBe(false)

  await page.close()
})

test('a socket disconnect leaves the window transport intact', async ({ window, browser }) => {
  await enableRemote(window)
  const status = await enableRemote(window)

  const page = await browser.newPage()
  await page.goto(byName(status.url!))
  await expect(page.getByTestId('screen-title')).toHaveText('Sessions', { timeout: 15_000 })
  await expect
    .poll(async () => (await window.evaluate(() => (window as unknown as { api: Api }).api.invoke('remote:status')) as RemoteAccessStatus).clients)
    .toBe(1)

  await page.close()

  await expect
    .poll(async () => (await window.evaluate(() => (window as unknown as { api: Api }).api.invoke('remote:status')) as RemoteAccessStatus).clients)
    .toBe(0)

  // The desktop renderer is unaffected — its own transport was never touched.
  expect(await window.evaluate(() => (window as unknown as { api: Api }).api.invoke('app:get-repo'))).toBeTruthy()
})
