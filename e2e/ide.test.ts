import { test, expect } from '@playwright/test'
import { _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { MAIN } from './fixtures'

const SANDBOX_ARGS = process.env.CI ? ['--no-sandbox'] : []

const repoPath = process.env.SIMPLEEDIT_TEST_REPO

// These tests require a bare git repo. Set SIMPLEEDIT_TEST_REPO to its path.
// Example: SIMPLEEDIT_TEST_REPO=/path/to/repo.git pnpm test:e2e
test.describe('IDE layout', () => {
  test.skip(!repoPath, 'Set SIMPLEEDIT_TEST_REPO to run IDE tests')

  let app: ElectronApplication
  let window: Page

  test.beforeEach(async () => {
    app = await electron.launch({
      args: [MAIN, ...SANDBOX_ARGS],
      env: { ...process.env, SIMPLEEDIT_REPO: repoPath! }
    })
    window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
  })

  test.afterEach(async () => {
    await app.close()
  })

  test('shows the repo name in the title bar', async () => {
    const repoName = repoPath!.split('/').pop()!.replace('.git', '')
    await expect(window.getByText(`SimpleEdit [${repoName}]`)).toBeVisible()
  })

  test('shows the sidebar', async () => {
    await expect(window.getByRole('complementary')).toBeVisible()
  })
})
