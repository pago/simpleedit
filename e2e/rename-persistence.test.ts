import { test, expect } from '@playwright/test'
import { _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execSync } from 'child_process'
import { MAIN, launchEnv, waitForWorktreesReady } from './fixtures'

const SANDBOX_ARGS = process.env.CI ? ['--no-sandbox'] : []

/**
 * Issue #100 (ported to agent-first UI): a renamed Claude session's custom
 * label must survive a quit/relaunch.
 *
 * Save: session-id is minted synchronously at PTY spawn, so the renamed
 * session is serialized WITH a sessionId + customLabel + label (SerializedSession
 * version 2). Restore: hydrateSession stages it as a click-to-resume placeholder
 * in the SessionList carrying the custom label.
 */
test.describe('Issue #100: rename persists across restart', () => {
  let testRoot: string
  let bareRepoPath: string
  let app: ElectronApplication
  let window: Page

  test.beforeAll(() => {
    testRoot = mkdtempSync(join(tmpdir(), 'simpleedit-issue100-'))
    const seedPath = join(testRoot, 'seed')
    mkdirSync(seedPath, { recursive: true })
    const sh = (cwd: string, cmd: string): void => { execSync(cmd, { cwd, stdio: 'pipe' }) }
    sh(seedPath, 'git init --initial-branch=main')
    sh(seedPath, 'git config user.email test@example.com')
    sh(seedPath, 'git config user.name Test')
    writeFileSync(join(seedPath, 'README.md'), '# seed\n')
    sh(seedPath, 'git add README.md')
    sh(seedPath, 'git commit -m initial')
    bareRepoPath = join(testRoot, 'project.git')
    sh(testRoot, `git clone --bare ${seedPath} ${bareRepoPath}`)
    sh(bareRepoPath, 'git config remote.origin.fetch +refs/heads/*:refs/remotes/origin/*')
    sh(bareRepoPath, `git worktree add ${join(testRoot, 'main')} main`)
  })

  test.afterAll(() => { rmSync(testRoot, { recursive: true, force: true }) })

  async function launch(): Promise<void> {
    app = await electron.launch({
      args: [MAIN, ...SANDBOX_ARGS],
      env: launchEnv({ SIMPLEEDIT_REPO: bareRepoPath }),
    })
    window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await waitForWorktreesReady(window)
  }

  test('a renamed Claude tab label comes back after relaunch', async () => {
    await launch()

    const claudeButton = window.getByRole('button', { name: 'New Claude session' }).first()
    await expect(claudeButton).toBeVisible({ timeout: 10_000 })
    await claudeButton.click()
    const tab = window.locator('[role="option"]:has-text("Claude")').first()
    await expect(tab).toBeVisible({ timeout: 5_000 })

    await tab.click({ button: 'right' })
    await window.getByRole('menuitem', { name: 'Rename…' }).click()
    const dialog = window.getByRole('dialog', { name: 'Rename session' })
    await dialog.getByRole('textbox').fill('My Renamed Session')
    await dialog.getByRole('button', { name: 'Rename' }).click()
    await expect(window.locator('[role="option"]:has-text("My Renamed Session")').first()).toBeVisible()

    // The app auto-saves session state on change with a 500ms debounce; wait
    // past it so the renamed label is persisted, then relaunch.
    await window.waitForTimeout(1_200)
    await app.close()

    await launch()
    // The renamed session returns as a resume placeholder carrying the label.
    await expect(
      window.locator('[role="option"]:has-text("My Renamed Session")').first(),
    ).toBeVisible({ timeout: 10_000 })
  })
})
