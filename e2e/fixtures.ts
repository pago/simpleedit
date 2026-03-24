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
    const app = await electron.launch({ args: [MAIN, ...SANDBOX_ARGS] })
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
        env: { ...process.env, SIMPLEEDIT_REPO: repoPath }
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
