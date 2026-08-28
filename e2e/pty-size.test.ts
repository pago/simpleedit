import { test as base, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import {
  MAIN,
  launchEnv,
  createTempRepo,
  removeTempRepo,
  spawnTerminalSession,
  measurePtySize as measure,
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
