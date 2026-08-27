import { test as base, expect, chromium, _electron as electron } from '@playwright/test'
import type { Browser, ElectronApplication, Page } from '@playwright/test'
import path from 'path'
import os from 'os'
import { MAIN, launchEnv, createTempRepo, removeTempRepo, type TempRepo } from './fixtures'
import type { RemoteAccessStatus } from '../src/shared/ipc-types'

/**
 * The transport, proved from an ordinary browser — no phone, no Tailscale.
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

test('a browser tab invokes into main and receives pushed events', async ({ window, browser }) => {
  const status = await enableRemote(window)

  // A terminal owned by the DESKTOP window, so the claim below is a real
  // transfer between two transports of one hub rather than a no-op.
  const terminalId = `term-remote-${Date.now()}`
  await window.evaluate(async (id) => {
    const api = (window as unknown as { api: Api }).api
    const worktrees = (await api.invoke('worktree:list')) as { path: string }[]
    await api.invoke('pty:spawn', { id, worktreePath: worktrees[0].path })
  }, terminalId)

  const page = await browser.newPage()
  await page.goto(status.url!)

  // ── invoke: a real result, from the same handler the renderer calls ──
  await expect(page.getByText(/Attached to window \d+ as w\d+\./)).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText(/worktree:list → \d+ worktree/)).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('code', { hasText: 'main' }).first()).toBeVisible()

  // ── event: a push nobody asked for, arriving over the same socket ──
  // Claiming the PTY from the browser moves size ownership away from the
  // desktop window, which is exactly the phase-2 gap: both transports are told.
  const desktopHeard = window.evaluate(
    (id) =>
      new Promise<string>((resolve) => {
        const off = (window as unknown as { api: Api }).api.on('pty:owner-changed', (data) => {
          const payload = data as { id: string; owner: string }
          if (payload.id !== id) return
          off()
          resolve(payload.owner)
        })
      }),
    terminalId,
  )

  await page.evaluate(
    (id) => (window as unknown as { api: Api }).api.invoke('pty:claim', id),
    terminalId,
  )

  await expect(page.getByText('pty:owner-changed')).toBeVisible({ timeout: 10_000 })
  // The desktop window learns it lost the size — main is authoritative, and it
  // now says so instead of silently dropping that window's resizes.
  const newOwner = await desktopHeard
  expect(newOwner).toMatch(/^w\d+\./)

  await window.evaluate((id) => (window as unknown as { api: Api }).api.invoke('pty:kill', id), terminalId)
  await page.close()
})

test('a socket disconnect leaves the window transport intact', async ({ window, browser }) => {
  const status = await enableRemote(window)

  const page = await browser.newPage()
  await page.goto(status.url!)
  await expect(page.getByText(/Attached to window \d+/)).toBeVisible({ timeout: 15_000 })
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
