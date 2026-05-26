import { test as base } from '@playwright/test'
import { _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
export const MAIN = path.join(ROOT, 'out/main/index.js')

// Chromium's sandbox requires kernel features unavailable in CI containers.
const SANDBOX_ARGS = process.env.CI ? ['--no-sandbox'] : []

// CI doesn't ship the real `claude` binary, so a Claude/Agent View PTY would
// exit immediately on `command not found`, the tab would auto-close via the
// pty:exit handler, and tests racing against Playwright's polling fail
// non-deterministically. Prepend a fake `claude` (e2e/bin) that just sleeps,
// keeping the PTY alive long enough for tab-strip assertions to land.
const E2E_BIN = path.join(__dirname, 'bin')
const PATH_KEY = process.platform === 'win32' ? 'Path' : 'PATH'
const PATH_SEP = process.platform === 'win32' ? ';' : ':'

/**
 * Build an env for `electron.launch` that prepends the e2e fake-binary
 * directory to PATH. Tests that need to spawn Claude PTYs should pass this
 * (merged with their own keys like SIMPLEEDIT_REPO) instead of `process.env`.
 */
export function launchEnv(extra: Record<string, string> = {}): Record<string, string> {
  const base = { ...process.env } as Record<string, string>
  base[PATH_KEY] = `${E2E_BIN}${PATH_SEP}${base[PATH_KEY] ?? ''}`
  return { ...base, ...extra }
}

type AppFixtures = {
  app: ElectronApplication
  window: Page
}

function assertBuilt(): void {
  if (!fs.existsSync(MAIN)) {
    throw new Error(
      `Built app not found at ${MAIN}\nRun "pnpm build" before running E2E tests.`
    )
  }
}

/** Launch the app without a repo — shows the Welcome screen. */
export const test = base.extend<AppFixtures>({
  app: async ({}, use) => {
    assertBuilt()
    const app = await electron.launch({ args: [MAIN, ...SANDBOX_ARGS], env: launchEnv() })
    await use(app)
    await app.close()
  },
  window: async ({ app }, use) => {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await use(page)
  }
})

/** Launch the app with a repo path — shows the IDE layout. */
export function makeRepoTest(repoPath: string) {
  return base.extend<AppFixtures>({
    app: async ({}, use) => {
      assertBuilt()
      const app = await electron.launch({
        args: [MAIN, ...SANDBOX_ARGS],
        env: launchEnv({ SIMPLEEDIT_REPO: repoPath })
      })
      await use(app)
      await app.close()
    },
    window: async ({ app }, use) => {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await use(page)
    }
  })
}

export { expect } from '@playwright/test'
