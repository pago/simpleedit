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

/**
 * Starting work from the phone, end to end: `+` → a brief → a real session.
 *
 * Nothing here is stubbed. The brief travels the socket, main asks the window's
 * own renderer, the renderer applies the same default ⌘T applies and mints the
 * terminal id, and the session comes back through main's per-window registry
 * to the list the phone is already rendering.
 */
test('starts a session from the phone, and it lands in the window\'s list', async ({ window, browser }) => {
  const status = await enableRemote(window)

  const page = await browser.newPage()
  await page.goto(byName(status.url!))
  await expect(page.getByTestId('screen-title')).toHaveText('Sessions', { timeout: 15_000 })

  // The one trailing action a top-level screen is allowed, opening a bottom
  // sheet — never a segmented control, never a second screen.
  await page.getByTestId('new-session').click()
  await expect(page.getByTestId('new-session-sheet')).toBeVisible()

  // Three words would start a session that opens by asking a question, so the
  // sheet says so — and still lets it through.
  await page.getByTestId('composer-text').fill('fix it')
  await expect(page.getByTestId('brief-nudge')).toBeVisible()

  const brief =
    'Rework the notification debounce so a session that flaps between running and waiting only buzzes once, and prove it with a test.'
  await page.getByTestId('composer-text').fill(brief)
  await expect(page.getByTestId('brief-nudge')).toHaveCount(0)
  await page.getByTestId('composer-send').click()

  // Confirmed by the label main derived from the brief's first clause.
  await expect(page.getByTestId('started-note')).toContainText('Rework the notification debounce', {
    timeout: 20_000,
  })

  // It is a session of the window this phone attached to — not a phantom the
  // phone drew for itself. Polled: main's registry is fed by the renderer's
  // own reactive push, which runs on its clock rather than the socket's.
  const listSessions = async (): Promise<{ terminalId: string; label: string }[]> =>
    (await window.evaluate(() =>
      (window as unknown as { api: Api }).api.invoke('session:list'),
    )) as { terminalId: string; label: string }[]
  const named = (s: { label: string }): boolean =>
    s.label.startsWith('Rework the notification debounce')
  await expect
    .poll(async () => (await listSessions()).some(named), { timeout: 15_000 })
    .toBe(true)

  // And it is openable like any other row.
  const started = (await listSessions()).find(named)!
  await expect(
    page.locator(`[data-testid="session-row"][data-session-id="${started.terminalId}"]`),
  ).toBeVisible({ timeout: 15_000 })

  await page.close()
})

/**
 * One confirmed intent, one session — across the real socket.
 *
 * Two calls naming the same `requestId` is what a double tap, a retry after a
 * dropped answer, and a replayed frame all look like by the time they reach
 * main. Getting this wrong costs a whole parallel slot: a second agent nobody
 * asked for, working the same brief.
 */
test('a repeated intent starts one session, not two', async ({ window, browser }) => {
  const status = await enableRemote(window)

  const page = await browser.newPage()
  await page.goto(byName(status.url!))
  await page.waitForFunction(() => 'api' in window, undefined, { timeout: 15_000 })

  const created = (await page.evaluate(async () => {
    const request = {
      requestId: 'e2e-one-intent',
      brief: 'Audit every path that can start a session and prove each one is idempotent.',
    }
    const api = (window as unknown as { api: Api }).api
    const first = (await api.invoke('session:create', request)) as { terminalId: string }
    const second = (await api.invoke('session:create', request)) as { terminalId: string }
    return [first.terminalId, second.terminalId]
  })) as [string, string]

  expect(created[1]).toBe(created[0])

  const sessions = (await window.evaluate(() =>
    (window as unknown as { api: Api }).api.invoke('session:list'),
  )) as { terminalId: string; label: string }[]
  expect(sessions.filter((s) => s.label.startsWith('Audit every path'))).toHaveLength(1)

  await page.close()
})

/**
 * The review surface, end to end.
 *
 * The component tests drive a mocked `window.api`; only this proves the reads
 * survive the trip — that `git:log` and `git:diff` resolve the window's repo
 * for a socket sender, and that the session's trail actually reaches the phone
 * rather than being derived there from paths it cannot map.
 */
test('reads the log and the diff of the worktree the session is in', async ({ window, browser, repo }) => {
  const terminalId = await spawnTerminalSession(window)
  const status = await enableRemote(window)

  const page = await browser.newPage()
  await page.goto(byName(status.url!))

  const row = page.locator(`[data-testid="session-row"][data-session-id="${terminalId}"]`)
  await expect(row).toBeVisible({ timeout: 15_000 })
  await row.click()

  // Detail chrome: two genuine panes is the one thing that earns a segmented
  // control, and it is labelled for this screen.
  await expect(page.getByTestId('pane-terminal')).toHaveText('Terminal')
  await expect(page.getByTestId('pane-changes')).toHaveText('Changes')
  await page.getByTestId('pane-changes').click()

  // The picker is the session's own trail, and the fixture's tree is clean, so
  // it opens on the newest commit — the same substitution the desk makes.
  await expect(page.getByTestId('worktree-select')).toHaveValue(repo.mainWorktreePath, {
    timeout: 15_000,
  })
  await expect(page.getByTestId('entry-title')).toHaveText('third commit', { timeout: 15_000 })
  await expect(page.getByTestId('session-diff')).toContainText('src/c.ts')
  await expect(page.getByTestId('session-diff')).toContainText('export const c = 3')

  // Back to the log, and an older commit's diff.
  await page.getByTestId('changes-back').click()
  const commits = page.getByTestId('entry-commit')
  await expect(commits).toHaveCount(3)
  await commits.nth(1).click()
  await expect(page.getByTestId('entry-title')).toHaveText('second commit')
  await expect(page.getByTestId('session-diff')).toContainText('export const b = 2')

  // The terminal was hidden behind Changes, never torn down.
  await page.getByTestId('pane-terminal').click()
  await expect(page.locator('.xterm-rows')).toContainText(/\S/, { timeout: 15_000 })

  await page.close()
})
