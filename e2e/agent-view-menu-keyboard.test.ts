import { test, expect } from '@playwright/test'
import { _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execSync } from 'child_process'
import { MAIN, launchEnv } from './fixtures'

const SANDBOX_ARGS = process.env.CI ? ['--no-sandbox'] : []

/**
 * Issue #90 QA additions — covers cases not in agent-view-menu.test.ts:
 *  1. Keyboard activation via Shift+F10 opens the menu
 *  2. Esc dismisses the menu AND returns focus to the ✦ button
 *  3. Multiple Agent View tabs are labelled `Agents`, `Agents 2`, `Agents 3` (label increments)
 *  4. Claude tab labels increment independently of Agents tab labels
 */
test.describe('Issue #90 QA — keyboard menu, focus return, label increments', () => {
  let testRoot: string
  let bareRepoPath: string
  let app: ElectronApplication
  let window: Page

  test.beforeAll(() => {
    testRoot = mkdtempSync(join(tmpdir(), 'simpleedit-issue90-qa-'))

    const seedPath = join(testRoot, 'seed')
    mkdirSync(seedPath, { recursive: true })
    const sh = (cwd: string, cmd: string): void => {
      execSync(cmd, { cwd, stdio: 'pipe' })
    }
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
  })

  test.afterEach(async () => {
    await app.close()
  })

  test('Shift+F10 on focused ✦ button opens the menu', async () => {
    const claudeButton = window.getByRole('button', { name: 'Run Claude Code' }).first()
    await expect(claudeButton).toBeVisible({ timeout: 10_000 })

    // Focus the button programmatically (mirrors keyboard nav landing on it).
    await claudeButton.focus()
    await window.keyboard.press('Shift+F10')

    const menu = window.getByRole('menu').first()
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'New Claude session' })).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'New Agent View session' })).toBeVisible()

    // Arrow down + Enter should pick the second item ("New Agent View session").
    await window.keyboard.press('ArrowDown')
    await window.keyboard.press('Enter')
    await expect(menu).not.toBeVisible()
    await expect(window.locator('[role="tab"]:has-text("Agents")').first()).toBeVisible({ timeout: 5_000 })
  })

  test('Escape returns focus to the ✦ button after dismissing the menu', async () => {
    const claudeButton = window.getByRole('button', { name: 'Run Claude Code' }).first()
    await expect(claudeButton).toBeVisible({ timeout: 10_000 })

    await claudeButton.click({ button: 'right' })
    const menu = window.getByRole('menu').first()
    await expect(menu).toBeVisible()

    await window.keyboard.press('Escape')
    await expect(menu).not.toBeVisible()

    // Focus should be on the ✦ button after dismissal.
    const focused = await window.evaluate(() => document.activeElement?.getAttribute('aria-label'))
    expect(focused).toBe('Run Claude Code')
  })

  test('Agent View labels increment as Agents, Agents 2, Agents 3 at spawn time', async () => {
    const claudeButton = window.getByRole('button', { name: 'Run Claude Code' }).first()
    await expect(claudeButton).toBeVisible({ timeout: 10_000 })

    // Spawn three Agent View tabs.
    for (let i = 0; i < 3; i++) {
      await claudeButton.click({ button: 'right' })
      await window.getByRole('menuitem', { name: 'New Agent View session' }).click()
      // Tiny pause for the tab to be inserted in the DOM.
      await window.waitForTimeout(120)
    }

    // The TUI's PTY title eventually overrides the "Agents" label on tabs whose
    // terminal has fully initialized — that's an existing handleTitleChange
    // behavior (TerminalTabs.svelte:182), not a #90 regression. So we verify the
    // SPAWN-TIME labels by checking that "Agents 3" (most recent) and "Agents 2"
    // are both present, which proves the counter increments per spawn.
    await expect(window.locator('[role="tab"]:has-text("Agents 3")').first()).toBeVisible({ timeout: 5_000 })
    await expect(window.locator('[role="tab"]:has-text("Agents 2")').first()).toBeVisible()
  })

  test('Claude and Agents tab labels increment independently', async () => {
    const claudeButton = window.getByRole('button', { name: 'Run Claude Code' }).first()
    await expect(claudeButton).toBeVisible({ timeout: 10_000 })

    // 1 Claude (left-click), 1 Agents (right-click → menu), 1 Claude, 1 Agents.
    await claudeButton.click()
    await window.waitForTimeout(150)
    await claudeButton.click({ button: 'right' })
    await window.getByRole('menuitem', { name: 'New Agent View session' }).click()
    await window.waitForTimeout(150)
    await claudeButton.click()
    await window.waitForTimeout(150)
    await claudeButton.click({ button: 'right' })
    await window.getByRole('menuitem', { name: 'New Agent View session' }).click()
    await window.waitForTimeout(150)

    // Expect: "Claude", "Claude 2", "Agents", "Agents 2".
    await expect(window.locator('[role="tab"]:has-text("Claude 2")').first()).toBeVisible({ timeout: 5_000 })
    await expect(window.locator('[role="tab"]:has-text("Agents 2")').first()).toBeVisible()
  })
})
