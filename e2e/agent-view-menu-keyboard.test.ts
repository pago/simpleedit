import { test, expect } from '@playwright/test'
import { _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execSync } from 'child_process'
import { MAIN, launchEnv, waitForWorktreesReady, GIT_FIXTURE_ENV } from './fixtures'

const SANDBOX_ARGS = process.env.CI ? ['--no-sandbox'] : []

/**
 * Issue #90 QA additions (ported to agent-first UI) — covers cases not in
 * agent-view-menu.test.ts:
 *  1. Keyboard nav within the new-session menu (ArrowDown + Enter) picks Agent View
 *  2. Esc dismisses the menu AND returns focus to the ✦ Agent button
 *  3. Multiple Agent View sessions are labelled `Agents`, `Agents 2`, `Agents 3`
 *  4. Claude session labels increment independently of Agents session labels
 *
 * In the agent-first UI the ✦ Agent button (aria-label "New Claude session")
 * lives in the SessionList sidebar; right-click opens its new-session menu.
 * Sessions are role="option" entries (was role="tab"). The button itself no
 * longer wires Shift+F10 to open the menu (that was the old terminal tab strip),
 * so the keyboard case below opens the menu via right-click then drives it with
 * the arrow keys.
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
      execSync(cmd, { cwd, stdio: 'pipe', env: GIT_FIXTURE_ENV })
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
    await waitForWorktreesReady(window)
  })

  test.afterEach(async () => {
    await app.close()
  })

  test('keyboard nav in the new-session menu (ArrowDown + Enter) picks Agent View', async () => {
    const claudeButton = window.getByRole('button', { name: 'New agent session' }).first()
    await expect(claudeButton).toBeVisible({ timeout: 10_000 })

    // Open the new-session menu (right-click; the button does not wire a
    // keyboard menu-open in the agent-first UI).
    await claudeButton.click({ button: 'right' })

    const menu = window.getByRole('menu').first()
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'New Claude session' })).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'New Agent View session' })).toBeVisible()

    // The first item is focused on open, so reaching Agent View takes one
    // ArrowDown per item before it. Derived rather than hard-coded: the entries
    // ahead of it are one per registered provider, so a fixed press count means
    // this test breaks every time a provider is added — which is precisely how
    // it broke when OpenCode became the third.
    const labels = await menu.getByRole('menuitem').allInnerTexts()
    const steps = labels.findIndex((l) => l.includes('New Agent View session'))
    expect(steps).toBeGreaterThan(0)
    for (let i = 0; i < steps; i++) await window.keyboard.press('ArrowDown')
    await window.keyboard.press('Enter')
    await expect(menu).not.toBeVisible()
    await expect(window.locator('[role="option"]:has-text("Agents")').first()).toBeVisible({ timeout: 5_000 })
  })

  test('Escape returns focus to the ✦ Agent button after dismissing the menu', async () => {
    const claudeButton = window.getByRole('button', { name: 'New agent session' }).first()
    await expect(claudeButton).toBeVisible({ timeout: 10_000 })

    await claudeButton.click({ button: 'right' })
    const menu = window.getByRole('menu').first()
    await expect(menu).toBeVisible()

    await window.keyboard.press('Escape')
    await expect(menu).not.toBeVisible()

    // Focus should be on the ✦ Agent button after dismissal.
    const focused = await window.evaluate(() => document.activeElement?.getAttribute('aria-label'))
    expect(focused).toBe('New agent session')
  })

  test('Agent View labels increment as Agents, Agents 2, Agents 3 at spawn time', async () => {
    const claudeButton = window.getByRole('button', { name: 'New agent session' }).first()
    await expect(claudeButton).toBeVisible({ timeout: 10_000 })

    // Spawn three Agent View sessions.
    for (let i = 0; i < 3; i++) {
      await claudeButton.click({ button: 'right' })
      await window.getByRole('menuitem', { name: 'New Agent View session' }).click()
      // Tiny pause for the entry to be inserted in the DOM.
      await window.waitForTimeout(120)
    }

    // Agent View sessions are created with customLabel:true (sessions store), so
    // the "Agents N" labels stay sticky against the TUI's OSC titles. Verify the
    // counter increments per spawn.
    await expect(window.locator('[role="option"]:has-text("Agents 3")').first()).toBeVisible({ timeout: 5_000 })
    await expect(window.locator('[role="option"]:has-text("Agents 2")').first()).toBeVisible()
  })

  test('Claude and Agents session labels increment independently', async () => {
    const claudeButton = window.getByRole('button', { name: 'New agent session' }).first()
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
    await expect(window.locator('[role="option"]:has-text("Claude 2")').first()).toBeVisible({ timeout: 5_000 })
    await expect(window.locator('[role="option"]:has-text("Agents 2")').first()).toBeVisible()
  })
})
