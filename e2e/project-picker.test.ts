import { test as base, expect, chromium, _electron as electron } from '@playwright/test'
import type { Browser, ElectronApplication, Page } from '@playwright/test'
import path from 'path'
import os from 'os'
import { MAIN, launchEnv, createTempRepo, removeTempRepo, spawnTerminalSession, type TempRepo } from './fixtures'
import type { RemoteAccessStatus } from '../src/shared/ipc-types'

/**
 * The phone's project picker, against two real windows.
 *
 * A phone borrows one window's identity, so switching project is a reconnect
 * naming the other window. What has to hold: the Sessions tab shows the chosen
 * window's sessions and nothing of the old one's, the choice survives a reload
 * (the installed app's storage), and when the attached window closes the phone
 * says where it went instead of changing silently.
 */

const SANDBOX_ARGS = process.env.CI ? ['--no-sandbox'] : []

type Fixtures = {
  repoA: TempRepo
  repoB: TempRepo
  app: ElectronApplication
  windowA: Page
  browser: Browser
}

const test = base.extend<Fixtures>({
  repoA: async ({}, use) => {
    const repo = createTempRepo('simpleedit-picker-a-')
    await use(repo)
    removeTempRepo(repo)
  },
  repoB: async ({}, use) => {
    const repo = createTempRepo('simpleedit-picker-b-')
    await use(repo)
    removeTempRepo(repo)
  },
  app: async ({ repoA }, use) => {
    const app = await electron.launch({
      args: [MAIN, ...SANDBOX_ARGS],
      env: launchEnv({
        SIMPLEEDIT_REPO: repoA.bareRepoPath,
        SIMPLEEDIT_E2E_REMOTE_CONFIG: path.join(os.tmpdir(), `simpleedit-picker-${process.pid}.json`),
      }),
    })
    await use(app)
    await app.close()
  },
  windowA: async ({ app }, use) => {
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

type Api = { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> }

async function openSecondWindow(app: ElectronApplication, windowA: Page, repo: TempRepo): Promise<Page> {
  const opened = app.waitForEvent('window')
  await windowA.evaluate(
    (repoPath) => (window as unknown as { api: Api }).api.invoke('app:open-window', repoPath),
    repo.bareRepoPath,
  )
  const page = await opened
  await page.waitForLoadState('domcontentloaded')
  return page
}

async function phoneUrl(window: Page): Promise<string> {
  const status = (await window.evaluate(
    () => (window as unknown as { api: Api }).api.invoke('remote:set-enabled', true),
  )) as RemoteAccessStatus
  const url = new URL(status.url!)
  url.hostname = 'localhost'
  return url.toString()
}

const row = (page: Page, terminalId: string) =>
  page.locator(`[data-testid="session-row"][data-session-id="${terminalId}"]`)

test('the phone switches project, remembers it, and says so when the window goes', async ({
  app,
  windowA,
  repoB,
  browser,
}) => {
  const sessionA = await spawnTerminalSession(windowA)
  const windowB = await openSecondWindow(app, windowA, repoB)
  const sessionB = await spawnTerminalSession(windowB)

  const url = await phoneUrl(windowA)
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 } })
  await phone.goto(url)
  await expect(phone.getByTestId('connection-dot')).toHaveAttribute('data-state', 'open', { timeout: 15_000 })

  // Unfocused test windows: wherever it landed, it shows exactly one window's list.
  await expect(row(phone, sessionA).or(row(phone, sessionB))).toBeVisible()
  const onA = await row(phone, sessionA).isVisible()
  const [here, there] = onA ? [sessionA, sessionB] : [sessionB, sessionA]
  await expect(row(phone, there)).toHaveCount(0)

  // Pick the other project.
  await phone.getByTestId('project-switcher').click()
  await expect(phone.getByTestId('project-sheet')).toBeVisible()
  await expect(phone.getByTestId('project-option')).toHaveCount(2)
  await phone.locator('[data-testid="project-option"]:not([aria-current])').click()
  await expect(phone.getByTestId('project-sheet')).toHaveCount(0)
  await expect(row(phone, there)).toBeVisible({ timeout: 15_000 })
  await expect(row(phone, here)).toHaveCount(0)
  await expect(phone.getByTestId('project-notice')).toHaveCount(0)

  // Remembered on the device: a reload comes back to the same project.
  await phone.reload()
  await expect(phone.getByTestId('connection-dot')).toHaveAttribute('data-state', 'open', { timeout: 15_000 })
  await expect(row(phone, there)).toBeVisible({ timeout: 15_000 })
  await expect(row(phone, here)).toHaveCount(0)

  // Close the window the phone is on: it falls back to the other, and says so.
  const attachedWindow = onA ? windowB : windowA
  await attachedWindow.evaluate(() => window.close())
  await expect(phone.getByTestId('project-notice')).toContainText("isn't open on the Mac", { timeout: 15_000 })
  await expect(row(phone, here)).toBeVisible({ timeout: 15_000 })
  await expect(row(phone, there)).toHaveCount(0)

  await phone.close()
})
