import { test, expect } from '@playwright/test'
import { _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execSync } from 'child_process'
import { MAIN, launchEnv, spawnTerminalSession, openWorktreePopover, GIT_FIXTURE_ENV } from './fixtures'

const SANDBOX_ARGS = process.env.CI ? ['--no-sandbox'] : []

/**
 * Issue #89: With a bare repo, `git worktree list --porcelain` ordering meant
 * the alphabetically-first linked worktree was marked as the "main" worktree,
 * and its delete button was suppressed. This test creates a bare repo with a
 * branch ("aaa-feature") that sorts before "main" and verifies that:
 *   - "aaa-feature" exposes a Remove button (i.e. NOT marked isMain), and
 *   - "main" does NOT expose a Remove button (correctly marked isMain).
 */
test.describe('Issue #89: isMain resolves by branch, not list order', () => {
  let testRoot: string
  let bareRepoPath: string
  let app: ElectronApplication
  let window: Page

  test.beforeAll(() => {
    testRoot = mkdtempSync(join(tmpdir(), 'simpleedit-issue89-'))

    // Seed repo: one commit on "main".
    const seedPath = join(testRoot, 'seed')
    mkdirSync(seedPath, { recursive: true })
    const sh = (cwd: string, cmd: string): void => {
      execSync(cmd, { cwd, stdio: 'pipe', env: GIT_FIXTURE_ENV })
    }
    sh(seedPath, 'git init --initial-branch=main')
    sh(seedPath, 'git config user.email test@example.com')
    sh(seedPath, 'git config user.name Test')
    writeFileSync(join(seedPath, 'README.md'), '# seed\n')
    sh(seedPath, 'git add README.md')
    sh(seedPath, 'git commit -m initial')

    // Bare clone — bare HEAD inherits "main".
    bareRepoPath = join(testRoot, 'project.git')
    sh(testRoot, `git clone --bare ${seedPath} ${bareRepoPath}`)
    sh(bareRepoPath, 'git config remote.origin.fetch +refs/heads/*:refs/remotes/origin/*')

    // Create a branch whose name sorts BEFORE "main" alphabetically.
    sh(bareRepoPath, 'git branch aaa-feature main')

    // Add both worktrees alongside the bare repo (this is the SimpleEdit layout).
    sh(bareRepoPath, `git worktree add ${join(testRoot, 'aaa-feature')} aaa-feature`)
    sh(bareRepoPath, `git worktree add ${join(testRoot, 'main')} main`)
  })

  test.afterAll(() => {
    rmSync(testRoot, { recursive: true, force: true })
  })

  test.beforeEach(async () => {
    app = await electron.launch({
      args: [MAIN, ...SANDBOX_ARGS],
      env: launchEnv({ SIMPLEEDIT_REPO: bareRepoPath })
    })
    window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    // The worktree list lives in the workspace header popover (f1e6062).
    await spawnTerminalSession(window)
  })

  test.afterEach(async () => {
    await app.close()
  })

  test('alphabetically-first worktree exposes Remove; default-branch worktree does not', async () => {
    const dialog = await openWorktreePopover(window)
    const listbox = dialog.getByRole('listbox', { name: 'Worktrees' })

    // Both worktrees should be present.
    const featureOption = listbox.getByRole('option', { name: /aaa-feature/ })
    const mainOption = listbox.getByRole('option', { name: /\bmain\b/ })
    await expect(featureOption).toBeVisible()
    await expect(mainOption).toBeVisible()

    // Bug-fix assertion: "aaa-feature" (alphabetically first) is NOT main.
    await featureOption.hover()
    await expect(featureOption.getByRole('button', { name: 'Remove' })).toBeVisible()

    // And "main" is correctly marked main — no Remove button.
    await mainOption.hover()
    await expect(mainOption.getByRole('button', { name: 'Remove' })).not.toBeVisible()
  })
})
