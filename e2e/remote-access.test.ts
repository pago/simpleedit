import { test as base, expect, chromium, _electron as electron } from '@playwright/test'
import type { Browser, ElectronApplication, Page } from '@playwright/test'
import path from 'path'
import os from 'os'
import { writeFileSync } from 'fs'
import { execSync } from 'child_process'
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
import { DIFF_TRUNCATED_MARKER } from '../src/shared/ipc-types'
import type { RemoteAccessStatus } from '../src/shared/ipc-types'

/**
 * The remote surface, proved from an ordinary browser — no phone, no Tailscale.
 *
 * `http://localhost` is a secure context, so verifying here is not a weaker
 * substitute for the real thing: it exercises the same server, the same key
 * gate, the same hub registration and the same `window.api` shim the phone
 * will use. Only the TLS in front of it differs.
 */

const SANDBOX_ARGS = process.env.CI ? ['--no-sandbox'] : []
const CONFIG_PATH = path.join(os.tmpdir(), `simpleedit-remote-${process.pid}.json`)

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
        SIMPLEEDIT_E2E_REMOTE_CONFIG: CONFIG_PATH,
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
  // `restartOnSamePort` pins a port; the next test must get an ephemeral one.
  writeFileSync(CONFIG_PATH, JSON.stringify({ enabled: false, host: '127.0.0.1', port: 0 }))
})

test('serves the shell without the key, the socket only with it, and holds a power assertion', async ({ window }) => {
  const status = await enableRemote(window)

  expect(status.running).toBe(true)
  expect(status.host).toBe('127.0.0.1')
  expect(status.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/app\/\?k=[0-9a-f]{64}$/)
  // Without this the Mac sleeps and the agents stop, silently.
  expect(status.powerSaveBlocked).toBe(true)

  const origin = new URL(status.url!).origin
  const key = new URL(status.url!).searchParams.get('k')!
  // The shell is public and holds no data…
  const shell = await fetch(`${origin}/app/`)
  expect(shell.status).toBe(200)
  expect(await shell.text()).toContain('SimpleEdit')
  // …and the one question it can ask without the key has a one-bit answer.
  expect((await fetch(`${origin}/app/auth?k=${key}`)).status).toBe(204)
  expect((await fetch(`${origin}/app/auth?k=${'0'.repeat(64)}`)).status).toBe(401)
  expect((await fetch(`${origin}/${key}/`, { redirect: 'manual' })).headers.get('location')).toBe('/app/?from=legacy')
})

/** Open a socket from a real browser page and report whether it got a `hello`. */
async function socketOpens(page: Page, url: string): Promise<boolean> {
  return await page.evaluate(
    (target) =>
      new Promise<boolean>((resolve) => {
        const ws = new WebSocket(target)
        ws.onmessage = () => { ws.close(); resolve(true) }
        ws.onerror = () => resolve(false)
        ws.onclose = () => resolve(false)
      }),
    url,
  )
}

test('no data or IPC is reachable from the shell without the key', async ({ window, browser }) => {
  const status = await enableRemote(window)
  const url = new URL(byName(status.url!))
  const key = url.searchParams.get('k')!
  const ws = `ws://${url.host}/app/ws`

  const page = await browser.newPage()
  await page.goto(`${url.origin}/app/`)
  expect(await socketOpens(page, ws)).toBe(false)
  expect(await socketOpens(page, `${ws}?k=${'0'.repeat(64)}`)).toBe(false)
  expect(await socketOpens(page, `ws://${url.host}/${key}/ws`)).toBe(false)
  expect(await socketOpens(page, `${ws}?k=${key}`)).toBe(true)
  await page.close()
})

/** Restart remote access on the SAME port, so the page's origin survives — as it does behind Serve. */
async function restartOnSamePort(window: Page, port: number): Promise<RemoteAccessStatus> {
  await window.evaluate(() => (window as unknown as { api: Api }).api.invoke('remote:set-enabled', false))
  writeFileSync(CONFIG_PATH, JSON.stringify({ enabled: false, host: '127.0.0.1', port }))
  return await enableRemote(window)
}

// The whole of #190 from a browser: a key goes stale, the app says so instead
// of 404ing, and a new link brings it back IN PLACE — same page, same
// storage — and a reload afterwards still prefers the new key over the stale
// one its URL keeps carrying, as an installed app's start URL does.
test('a stale key shows the stale page, and a new link reconnects without navigating', async ({ window, browser }) => {
  const first = await enableRemote(window)
  const firstUrl = byName(first.url!)

  const page = await browser.newPage()
  await page.goto(firstUrl)
  await expect(page.getByTestId('connection-dot')).toHaveAttribute('data-state', 'open', { timeout: 15_000 })

  const second = await restartOnSamePort(window, first.port!)
  expect(second.port).toBe(first.port)
  const secondUrl = byName(second.url!)
  expect(secondUrl).not.toBe(firstUrl)

  await expect(page.getByTestId('pair-screen')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('pair-title')).toHaveText('This link is out of date')

  await page.evaluate(() => { (window as unknown as { marker: string }).marker = 'same page' })
  await page.getByTestId('pair-link').fill(secondUrl)
  await page.getByTestId('pair-connect').click()
  await expect(page.getByTestId('pair-screen')).toBeHidden({ timeout: 15_000 })
  await expect(page.getByTestId('connection-dot')).toHaveAttribute('data-state', 'open')
  expect(await page.evaluate(() => (window as unknown as { marker?: string }).marker)).toBe('same page')
  expect(page.url()).toBe(firstUrl)

  // Relaunch on the stale start URL: the stored key wins.
  await page.goto(firstUrl)
  await expect(page.getByTestId('connection-dot')).toHaveAttribute('data-state', 'open', { timeout: 15_000 })
  await expect(page.getByTestId('pair-screen')).toBeHidden()
  await page.close()
})

test('an old /<key>/ link lands on the stale-key page', async ({ window, browser }) => {
  const status = await enableRemote(window)
  const origin = new URL(byName(status.url!)).origin

  const page = await browser.newPage()
  await page.goto(`${origin}/${'e'.repeat(64)}/`)
  expect(new URL(page.url()).pathname).toBe('/app/')
  await expect(page.getByTestId('pair-title')).toHaveText('This link is out of date', { timeout: 15_000 })
  await expect(page.getByTestId('pair-legacy')).toBeVisible()
  await page.close()
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

  // Detail chrome: a back button, and the tab bar still there — another tab
  // is one tap away from a detail screen too.
  await row.click()
  await expect(page.getByTestId('back')).toBeVisible()
  await expect(page.getByTestId('tab-bar')).toBeVisible()
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

  // Back to the log — the shell's back, named for where it goes — and an
  // older commit's diff.
  await expect(page.getByTestId('back')).toHaveText(/Changes/)
  await page.getByTestId('back').click()
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

/**
 * A diff big enough to hang up on the client that asked for it.
 *
 * A phone reads a diff over the SAME socket its terminal streams on, and that
 * socket is closed with 1013 as soon as its buffer passes a megabyte. So an
 * uncapped diff is not a slow read — it disconnects the client, drops the live
 * PTY stream, and the pane's reconnect handler re-issues the identical read.
 *
 * The cap belongs to the transport, so it is applied where the transport is
 * known: the desktop asks the same channel over IPC and still gets all of it.
 */
test('bounds a huge diff for a socket, and only for a socket', async ({ repo, window, browser }) => {
  const bulk = Array.from({ length: 40_000 }, (_, i) => `line ${i} ${'x'.repeat(60)}`).join('\n')
  writeFileSync(path.join(repo.mainWorktreePath, 'big.txt'), `${bulk}\n`)
  execSync('git add . && git commit -m "a big one"', {
    cwd: repo.mainWorktreePath,
    stdio: 'pipe',
    env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@e.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@e.com' },
  })
  const head = execSync('git rev-parse HEAD', { cwd: repo.mainWorktreePath, env: process.env })
    .toString()
    .trim()

  const status = await enableRemote(window)
  const page = await browser.newPage()
  await page.goto(byName(status.url!))
  await page.waitForFunction(() => 'api' in window, undefined, { timeout: 15_000 })

  const overSocket = (await page.evaluate(
    ([wt, sha]) => (window as unknown as { api: Api }).api.invoke('git:diff', wt, sha),
    [repo.mainWorktreePath, head] as const,
  )) as string

  expect(new TextEncoder().encode(overSocket).byteLength).toBeLessThanOrEqual(256 * 1024)
  expect(overSocket).toContain(DIFF_TRUNCATED_MARKER)
  // Cut on a line boundary: half a hunk line is a corrupt diff, not a smaller one.
  const body = overSocket.slice(0, overSocket.indexOf(DIFF_TRUNCATED_MARKER)).trimEnd()
  expect(body.endsWith('x')).toBe(true)

  // The socket that carried it is still the client's.
  await expect(page.getByTestId('connection-dot')).toHaveAttribute('data-state', 'open')

  // The desktop reaches the same handler over IPC and is not capped: it is
  // where you go to read the rest.
  const atTheDesk = (await window.evaluate(
    ([wt, sha]) => (window as unknown as { api: Api }).api.invoke('git:diff', wt, sha),
    [repo.mainWorktreePath, head] as const,
  )) as string
  expect(atTheDesk.length).toBeGreaterThan(overSocket.length)
  expect(atTheDesk).not.toContain(DIFF_TRUNCATED_MARKER)

  await page.close()
})
