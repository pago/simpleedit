import { test as base, expect, chromium, _electron as electron } from '@playwright/test'
import type { Browser, ElectronApplication, Page } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { MAIN, launchEnv, createTempRepo, removeTempRepo, type TempRepo } from './fixtures'
import type { RemoteAccessStatus, ScreenPrsState } from '../src/shared/ipc-types'

/**
 * Screen PRs belongs to the app, not to the window that started it: a phone
 * can switch project while a screening runs and still see it end, and any
 * client can stop it.
 *
 * `gh` is a stub on PATH whose search waits while a hold file exists, so the
 * test decides when the run ends. Its answer is an empty queue, which is all
 * a finished run needs; no model is ever called.
 */

const SANDBOX_ARGS = process.env.CI ? ['--no-sandbox'] : []

const FAKE_GH = `#!/usr/bin/env bash
case "$1 $2" in
  "api user") echo me ;;
  "search prs")
    while [ -e "$FAKE_GH_HOLD" ]; do sleep 0.1; done
    echo '[]' ;;
  *) exit 1 ;;
esac
`

type Fixtures = {
  repoA: TempRepo
  repoB: TempRepo
  hold: string
  app: ElectronApplication
  windowA: Page
  browser: Browser
}

const test = base.extend<Fixtures>({
  repoA: async ({}, use) => {
    const repo = createTempRepo('simpleedit-shared-run-a-')
    await use(repo)
    removeTempRepo(repo)
  },
  repoB: async ({}, use) => {
    const repo = createTempRepo('simpleedit-shared-run-b-')
    await use(repo)
    removeTempRepo(repo)
  },
  hold: async ({ repoA }, use) => {
    await use(path.join(repoA.root, 'gh-hold'))
  },
  app: async ({ repoA, hold }, use) => {
    const bin = path.join(repoA.root, 'fake-gh-bin')
    fs.mkdirSync(bin, { recursive: true })
    fs.writeFileSync(path.join(bin, 'gh'), FAKE_GH, { mode: 0o755 })
    const env = launchEnv({
      SIMPLEEDIT_REPO: repoA.bareRepoPath,
      SIMPLEEDIT_E2E_REMOTE_CONFIG: path.join(os.tmpdir(), `simpleedit-shared-run-${process.pid}.json`),
      SIMPLEEDIT_E2E_SCREENPRS_FILTER: path.join(repoA.root, 'screenprs-filter.json'),
      FAKE_GH_HOLD: hold,
    })
    env.PATH = `${bin}${path.delimiter}${env.PATH ?? ''}`
    const app = await electron.launch({ args: [MAIN, ...SANDBOX_ARGS], env })
    await use(app)
    // Released first: a stopped run's `gh` stub is still polling it, and the
    // app's close timed out in CI while it was.
    fs.rmSync(hold, { force: true })
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

const invoke = (page: Page, channel: string, ...args: unknown[]): Promise<unknown> =>
  page.evaluate(([ch, rest]) => (window as unknown as { api: Api }).api.invoke(ch, ...rest), [channel, args] as const)

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
  const status = (await invoke(window, 'remote:set-enabled', true)) as RemoteAccessStatus
  const url = new URL(status.url!)
  url.hostname = 'localhost'
  return url.toString()
}

test('the phone switches project mid-screening, sees it finish, and any client can stop it', async ({
  app,
  windowA,
  repoB,
  hold,
  browser,
}) => {
  const windowB = await openSecondWindow(app, windowA, repoB)
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 } })
  await phone.goto(await phoneUrl(windowA))
  await expect(phone.getByTestId('connection-dot')).toHaveAttribute('data-state', 'open', { timeout: 15_000 })

  // The phone starts a screening that cannot finish yet.
  fs.writeFileSync(hold, '')
  await phone.getByTestId('tab-prs-button').click()
  await phone.getByTestId('screen-prs').click()
  await expect(phone.getByTestId('screen-prs')).toHaveText('Screening…')
  // Main holds it for the app, so either window sees it.
  await expect.poll(async () => ((await invoke(windowB, 'screenprs:state')) as ScreenPrsState).run.status).toBe('running')

  // The picker no longer refuses a switch while it runs.
  await phone.getByTestId('project-switcher').click()
  await expect(phone.getByTestId('project-sheet')).toBeVisible()
  await expect(phone.getByTestId('project-blocked')).toHaveCount(0)
  await phone.locator('[data-testid="project-option"]:not([aria-current])').click()
  await expect(phone.getByTestId('project-sheet')).toHaveCount(0)
  await expect(phone.getByTestId('connection-dot')).toHaveAttribute('data-state', 'open', { timeout: 15_000 })

  await phone.getByTestId('tab-prs-button').click()
  await expect(phone.getByTestId('screen-prs')).toHaveText('Screening…')

  // The run ends after the switch, and the phone hears it on the new window.
  fs.rmSync(hold)
  await expect(phone.getByTestId('screen-prs')).toHaveText('Re-screen', { timeout: 15_000 })
  await expect(phone.getByTestId('pr-board')).toContainText('No pull requests are waiting on your review.')

  // A second run, started on the phone and stopped from a desktop window.
  fs.writeFileSync(hold, '')
  await phone.getByTestId('screen-prs').click()
  await expect(phone.getByTestId('screen-prs')).toHaveText('Screening…')
  await invoke(windowA, 'screenprs:cancel')
  await expect(phone.getByTestId('cancel-screen')).toHaveCount(0, { timeout: 15_000 })
  await expect(phone.getByTestId('screen-prs')).toHaveText('Re-screen')
  await expect(phone.getByTestId('pr-board')).toContainText('Screening was stopped')

  await phone.close()
})
