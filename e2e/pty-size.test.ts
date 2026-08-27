import { test as base, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import {
  MAIN,
  launchEnv,
  createTempRepo,
  removeTempRepo,
  spawnTerminalSession,
  type TempRepo,
} from './fixtures'

/**
 * The PTY's geometry must follow the terminal's container. Asking the shell
 * itself with `stty size` is the only honest check — it reports what the
 * kernel believes the terminal is, not what xterm happened to draw.
 *
 * What these do NOT cover: the reflow-while-blurred case. Under Playwright's
 * Electron driver `document.hasFocus()` stays true through `win.blur()` and
 * through focusing a second window, so a renderer that gates on attention
 * cannot be caught misbehaving here. That case is covered in
 * `src/main/__tests__/pty-ownership.test.ts`, where a claim is checked to
 * carry its geometry.
 */

const SANDBOX_ARGS = process.env.CI ? ['--no-sandbox'] : []

/** node-pty's spawn defaults — what a PTY that was never resized still reports. */
const SPAWN_COLS = 80
const SPAWN_ROWS = 24

type Fixtures = { repo: TempRepo; app: ElectronApplication; window: Page }

const test = base.extend<Fixtures>({
  repo: async ({}, use) => {
    const repo = createTempRepo('simpleedit-ptysize-')
    await use(repo)
    removeTempRepo(repo)
  },
  app: async ({ repo }, use) => {
    const app = await electron.launch({
      args: [MAIN, ...SANDBOX_ARGS],
      env: launchEnv({ SIMPLEEDIT_REPO: repo.bareRepoPath }),
    })
    await use(app)
    await app.close()
  },
  window: async ({ app }, use) => {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await use(page)
  },
})

type Api = { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> }

/**
 * Ask the shell for its own window size.
 *
 * The marker is assembled from two string literals so the echo of the command
 * itself never matches — only the output does.
 */
const SIZE_COMMAND = `stty size | awk '{print "SI" "ZE=" $1 "x" $2}'\r`

async function readSize(window: Page, id: string): Promise<{ rows: number; cols: number } | null> {
  const backlog = (await window.evaluate(
    (terminalId) => (window as unknown as { api: Api }).api.invoke('pty:backlog', terminalId),
    id,
  )) as { data: string }
  const matches = [...backlog.data.matchAll(/SIZE=(\d+)x(\d+)/g)]
  const last = matches.at(-1)
  return last ? { rows: Number(last[1]), cols: Number(last[2]) } : null
}

async function askSize(window: Page, id: string): Promise<void> {
  await window.evaluate(
    ([terminalId, command]) =>
      (window as unknown as { api: Api }).api.invoke('pty:write', terminalId, command),
    [id, SIZE_COMMAND],
  )
}

/** Run `stty size` and wait for an answer that differs from the previous one. */
async function measure(window: Page, id: string, previous?: { rows: number; cols: number }) {
  let latest: { rows: number; cols: number } | null = null
  await expect
    .poll(
      async () => {
        await askSize(window, id)
        const size = await readSize(window, id)
        if (!size) return false
        if (previous && size.rows === previous.rows && size.cols === previous.cols) return false
        latest = size
        return true
      },
      { timeout: 20_000, intervals: [500] },
    )
    .toBe(true)
  return latest!
}

test('the PTY is sized to its container, not left at the spawn default', async ({ window }) => {
  const id = await spawnTerminalSession(window)

  const initial = await measure(window, id)
  expect(initial.cols).toBeGreaterThan(SPAWN_COLS)
  expect(initial.rows).toBeGreaterThan(SPAWN_ROWS)
})

test('a container reflow reaches the PTY', async ({ app, window }) => {
  const id = await spawnTerminalSession(window)
  const before = await measure(window, id)

  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setSize(900, 520)
  })

  const after = await measure(window, id, before)
  expect(after.rows).toBeLessThan(before.rows)
  expect(after.cols).toBeLessThan(before.cols)
})
