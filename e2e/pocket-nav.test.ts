import { test as base, expect, chromium, _electron as electron } from '@playwright/test'
import type { Browser, ElectronApplication, Page, WebSocketRoute } from '@playwright/test'
import path from 'path'
import os from 'os'
import { MAIN, launchEnv, createTempRepo, removeTempRepo, spawnTerminalSession, type TempRepo } from './fixtures'
import type { RemoteAccessStatus } from '../src/shared/ipc-types'
import type { ScreenPrCard } from '../src/shared/screenprs'

/**
 * The phone's navigation, driven by the browser's own Back.
 *
 * `page.goBack()` is the same history traversal an iOS swipe-back or Android's
 * Back button performs, so these prove the app answers it — closing the
 * screen or sheet on top — instead of leaving. What they cannot prove is the
 * iOS standalone (Home Screen) gesture itself, which only exists on a device.
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
    const repo = createTempRepo('simpleedit-pocket-nav-')
    await use(repo)
    removeTempRepo(repo)
  },
  app: async ({ repo }, use) => {
    const app = await electron.launch({
      args: [MAIN, ...SANDBOX_ARGS],
      env: launchEnv({
        SIMPLEEDIT_REPO: repo.bareRepoPath,
        SIMPLEEDIT_E2E_REMOTE_CONFIG: path.join(os.tmpdir(), `simpleedit-pocket-nav-${process.pid}.json`),
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
}

async function phoneUrl(window: Page): Promise<string> {
  const status = (await window.evaluate(
    () => (window as unknown as { api: Api }).api.invoke('remote:set-enabled', true),
  )) as RemoteAccessStatus
  const url = new URL(status.url!)
  url.hostname = 'localhost'
  return url.toString()
}

test.afterEach(async ({ window }) => {
  await window.evaluate(() => (window as unknown as { api: Api }).api.invoke('remote:set-enabled', false))
})

const CARD: ScreenPrCard = {
  owner: 'acme', repo: 'acme/widgets', number: 7, url: 'https://github.com/acme/widgets/pull/7',
  title: 'Tighten the gate', author: 'dana', updatedAt: '2026-08-01T00:00:00Z',
  headSha: 'sha1', additions: 1, deletions: 0, changedFiles: 1,
  baseRefName: 'main', headRefName: 'feat', ci: 'green', ciFailing: [],
  reviewers: [], approvedByOther: false, body: 'Body text.', diff: '',
  impact: 'low', findings: [], bucket: 'quick',
}

/**
 * Open the phone with its socket routed through the test, so a screened PR can
 * be delivered without `gh` or a model: screening is main pushing
 * `screenprs:*` events down this socket, and this pushes the same frames.
 */
async function openPhone(browser: Browser, url: string): Promise<{ page: Page; socket: () => WebSocketRoute }> {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  let route: WebSocketRoute | null = null
  await page.routeWebSocket(/\/ws$/, (ws) => {
    ws.connectToServer()
    route = ws
  })
  await page.goto(url)
  await expect(page.getByTestId('connection-dot')).toHaveAttribute('data-state', 'open', { timeout: 15_000 })
  return {
    page,
    socket: () => {
      if (!route) throw new Error('The phone never opened its socket')
      return route
    },
  }
}

function deliverPr(socket: WebSocketRoute): void {
  socket.send(JSON.stringify({ kind: 'event', channel: 'screenprs:queued', data: { refs: [CARD] } }))
  socket.send(JSON.stringify({ kind: 'event', channel: 'screenprs:card', data: { card: CARD } }))
}

const visibleSession = (page: Page, terminalId: string) =>
  page.locator(`[data-testid="session-screen"][data-terminal-id="${terminalId}"]`)

const visibleComposer = (page: Page) => page.locator('[data-testid="composer-text"]:visible')

test('browser Back closes a sheet, then the PR under it, then stays in the app', async ({ window, browser }) => {
  const url = await phoneUrl(window)
  const { page, socket } = await openPhone(browser, url)

  deliverPr(socket())
  await page.getByTestId('tab-prs-button').click()
  await page.getByTestId('pr-card').click()
  await expect(page.getByTestId('screen-title')).toHaveText('acme/widgets#7')
  await expect(page.getByTestId('back')).toHaveText(/PRs/)

  // A sheet on top of the PR: Back takes the sheet, and only the sheet.
  await page.getByTestId('review-toggle').click()
  await page.getByTestId('dictate-summary').click()
  await expect(page.getByTestId('compose-sheet')).toBeVisible()
  await page.goBack()
  await expect(page.getByTestId('compose-sheet')).toHaveCount(0)
  await expect(page.getByTestId('screen-title')).toHaveText('acme/widgets#7')

  // With text in it, Back asks instead of discarding, and the text survives.
  await page.getByTestId('dictate-summary').click()
  await visibleComposer(page).fill('Ship it once the gate flips')
  await page.goBack()
  await expect(page.getByTestId('compose-discard-confirm')).toBeVisible()
  await expect(visibleComposer(page)).toHaveValue('Ship it once the gate flips')
  await page.getByTestId('compose-discard-confirmed').click()
  await expect(page.getByTestId('compose-sheet')).toHaveCount(0)

  await page.goBack()
  await expect(page.getByTestId('screen-title')).toHaveText('PRs')
  await expect(page.getByTestId('pr-card')).toBeVisible()

  // The new-session sheet is a layer too.
  await page.getByTestId('tab-sessions-button').click()
  await page.getByTestId('new-session').click()
  await expect(page.getByTestId('new-session-sheet')).toBeVisible()
  await page.goBack()
  await expect(page.getByTestId('new-session-sheet')).toHaveCount(0)

  await page.getByTestId('new-session').click()
  await visibleComposer(page).fill('A brief worth keeping')
  await page.goBack()
  await expect(page.getByTestId('discard-confirm')).toBeVisible()
  await page.getByRole('button', { name: 'Keep writing' }).click()
  await expect(visibleComposer(page)).toHaveValue('A brief worth keeping')
  // Asked again on the next Back — the held entry went back onto history.
  await page.goBack()
  await expect(page.getByTestId('discard-confirm')).toBeVisible()
  await page.getByTestId('discard-confirmed').click()
  await expect(page.getByTestId('new-session-sheet')).toHaveCount(0)

  // Still the app, at the list.
  expect(new URL(page.url()).pathname).toBe(new URL(url).pathname)
  await expect(page.getByTestId('screen-title')).toHaveText('Sessions')

  await page.close()
})

test('Back from a notification\'s session returns to the one that was open, draft intact', async ({
  window,
  browser,
}) => {
  const first = await spawnTerminalSession(window)
  const second = await spawnTerminalSession(window)
  const url = await phoneUrl(window)
  const { page } = await openPhone(browser, url)

  await page.locator(`[data-testid="session-row"][data-session-id="${first}"]`).click()
  await expect(visibleSession(page, first)).toBeVisible()
  await visibleComposer(page).fill('half a reply')

  // What the service worker posts to a focused tab when a notification is tapped.
  // The page's URL is passed in: `window` in this scope is the desktop fixture.
  await page.evaluate(
    ([terminalId, href]) => {
      navigator.serviceWorker.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'open-session', terminalId, url: href, windowId: null },
        }),
      )
    },
    [second, page.url()] as const,
  )

  await expect(visibleSession(page, second)).toBeVisible()
  await expect(visibleSession(page, first)).toBeHidden()
  // Covered, not closed: the first session is still mounted underneath.
  await expect(visibleSession(page, first)).toHaveCount(1)

  await page.goBack()
  await expect(visibleSession(page, first)).toBeVisible()
  await expect(visibleComposer(page)).toHaveValue('half a reply')
  await expect(visibleSession(page, second)).toHaveCount(0)

  await page.goBack()
  await expect(page.getByTestId('screen-title')).toHaveText('Sessions')

  await page.close()
})

test('a cold launch from a notification lands on the session with the list under it', async ({
  window,
  browser,
}) => {
  const terminalId = await spawnTerminalSession(window)
  const url = await phoneUrl(window)
  const page = await browser.newPage()
  await page.goto(`${url}#session=${terminalId}`)

  await expect(visibleSession(page, terminalId)).toBeVisible({ timeout: 15_000 })
  // The fragment is spent, so a reload would not replay it.
  expect(new URL(page.url()).hash).toBe('')

  await page.goBack()
  await expect(page.getByTestId('screen-title')).toHaveText('Sessions')
  await expect(page.locator(`[data-testid="session-row"][data-session-id="${terminalId}"]`)).toBeVisible()

  await page.close()
})

test('switching tabs keeps the other tab\'s screen, and Back never switches tabs', async ({
  window,
  browser,
}) => {
  const terminalId = await spawnTerminalSession(window)
  const url = await phoneUrl(window)
  const { page, socket } = await openPhone(browser, url)

  await page.locator(`[data-testid="session-row"][data-session-id="${terminalId}"]`).click()
  await expect(visibleSession(page, terminalId)).toBeVisible()
  await expect(page.locator('.xterm-rows')).toContainText(/\S/, { timeout: 15_000 })
  await page.getByTestId('pane-changes').click()
  await expect(page.getByTestId('changes-pane')).toBeVisible()

  deliverPr(socket())
  await page.getByTestId('tab-prs-button').click()
  await page.getByTestId('pr-card').click()
  await page.getByTestId('pane-files').click()

  // Back to Sessions: the session is still open, on the pane it was left on.
  await page.getByTestId('tab-sessions-button').click()
  await expect(visibleSession(page, terminalId)).toBeVisible()
  await expect(page.getByTestId('changes-pane')).toBeVisible()
  await expect(page.getByTestId('screen-title')).not.toHaveText('Sessions')

  // And the PR is still open on Files.
  await page.getByTestId('tab-prs-button').click()
  await expect(page.getByTestId('screen-title')).toHaveText('acme/widgets#7')
  await expect(page.getByTestId('pane-files')).toHaveAttribute('aria-pressed', 'true')

  // Back walks this tab only: out of the PR to the board, then no further.
  await page.goBack()
  await expect(page.getByTestId('screen-title')).toHaveText('PRs')
  await page.getByTestId('tab-sessions-button').click()
  await expect(visibleSession(page, terminalId)).toBeVisible()

  await page.close()
})
