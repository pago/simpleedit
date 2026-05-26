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
 * Issue #87 (PR1): right-click a Claude tab → context menu with Rename
 * enabled (Fork + Close session disabled placeholders). Rename submits via
 * PromptModal; new label is sticky (not overwritten by xterm OSC titles)
 * and persists across session save/load.
 */
test.describe('Issue #87 PR1: tab context menu + rename', () => {
  let testRoot: string
  let bareRepoPath: string
  let app: ElectronApplication
  let window: Page

  test.beforeAll(() => {
    testRoot = mkdtempSync(join(tmpdir(), 'simpleedit-issue87-'))

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
    // Clear any session payload that an earlier test may have written. Prevents
    // pendingResume placeholders from blocking the terminal pane on launch.
    interface ApiOnly { api: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> } }
    await window.evaluate(
      async (r) => (window as unknown as ApiOnly).api.invoke('session:clear', r),
      bareRepoPath,
    )
  })

  test.afterEach(async () => {
    await app.close()
  })

  // Helper: spawn a Claude tab via the ✦ button's left-click.
  async function spawnClaudeTab(): Promise<void> {
    const claudeButton = window.getByRole('button', { name: 'Run Claude Code' }).first()
    await expect(claudeButton).toBeVisible({ timeout: 10_000 })
    await claudeButton.click()
    await expect(window.locator('button:has-text("Claude")').first()).toBeVisible({ timeout: 5_000 })
  }

  test('right-click a Claude tab opens menu with Rename enabled; Fork and Close are disabled', async () => {
    await spawnClaudeTab()

    const claudeTab = window.locator('button:has-text("Claude")').first()
    await claudeTab.click({ button: 'right' })

    const menu = window.getByRole('menu').first()
    await expect(menu).toBeVisible()

    // Rename is the only enabled item.
    const rename = menu.getByRole('menuitem', { name: 'Rename…' })
    await expect(rename).toBeVisible()
    await expect(rename).not.toBeDisabled()

    // Fork + Close session are disabled placeholders for PR2/PR3.
    const fork = menu.getByRole('menuitem', { name: 'Fork into worktree…' })
    await expect(fork).toBeDisabled()
    await expect(fork).toHaveAttribute('title', 'Coming soon')

    const close = menu.getByRole('menuitem', { name: 'Close session' })
    await expect(close).toBeDisabled()
    await expect(close).toHaveAttribute('title', 'Coming soon')

    // Esc dismisses without action.
    await window.keyboard.press('Escape')
    await expect(menu).not.toBeVisible()
  })

  test('Rename… opens a PromptModal; submitting changes the tab label', async () => {
    await spawnClaudeTab()

    const claudeTab = window.locator('button:has-text("Claude")').first()
    await claudeTab.click({ button: 'right' })
    await window.getByRole('menuitem', { name: 'Rename…' }).click()

    const dialog = window.getByRole('dialog', { name: 'Rename tab' })
    await expect(dialog).toBeVisible()

    const input = dialog.getByRole('textbox')
    await expect(input).toBeFocused()
    await input.fill('My experiment')
    await dialog.getByRole('button', { name: 'Rename' }).click()

    await expect(dialog).not.toBeVisible()
    await expect(window.locator('button:has-text("My experiment")').first()).toBeVisible()
  })

  test('user-set label survives a session save/load round-trip via customLabel', async () => {
    interface ApiOnly { api: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> } }

    const worktreePath = join(testRoot, 'main')
    const payload = {
      version: 1,
      repoPath: bareRepoPath,
      savedAt: new Date().toISOString(),
      layout: {
        primaryWorktreePath: worktreePath,
        secondaryWorktreePath: null,
        focusedPane: 'primary' as const,
        splitRatio: 50,
        visitedPrimary: [worktreePath],
        visitedSecondary: [],
      },
      worktreeStates: [
        {
          worktreePath,
          tabs: [],
          activeTabId: null,
          mru: [],
          unread: [],
          primaryClaudeSessions: [
            { label: 'My experiment', sessionId: 'sid-1', customLabel: true },
            { label: 'Agents', isAgentView: true, customLabel: true },
            { label: 'untouched', sessionId: 'sid-2' },
          ],
          secondaryClaudeSessions: [],
        },
      ],
    }

    await window.evaluate(
      async (p) => (window as unknown as ApiOnly).api.invoke('session:save', p),
      payload,
    )
    const loaded = (await window.evaluate(
      async (r) => (window as unknown as ApiOnly).api.invoke('session:load', r),
      bareRepoPath,
    )) as typeof payload | null

    expect(loaded).not.toBeNull()
    const sessions = loaded!.worktreeStates[0].primaryClaudeSessions

    const renamed = sessions.find((s) => s.label === 'My experiment')!
    expect(renamed.customLabel).toBe(true)
    expect(renamed.sessionId).toBe('sid-1')

    const agentsRenamed = sessions.find((s) => s.label === 'Agents')!
    expect(agentsRenamed.customLabel).toBe(true)
    expect(agentsRenamed.isAgentView).toBe(true)

    // Non-renamed entries should NOT have customLabel set.
    const untouched = sessions.find((s) => s.label === 'untouched')!
    expect(untouched.customLabel).toBeUndefined()

    await window.evaluate(
      async (r) => (window as unknown as ApiOnly).api.invoke('session:clear', r),
      bareRepoPath,
    )
  })

  test('Shift+F10 on a focused Claude tab opens the menu', async () => {
    await spawnClaudeTab()

    const claudeTab = window.locator('button:has-text("Claude")').first()
    await claudeTab.focus()
    await window.keyboard.press('Shift+F10')

    const menu = window.getByRole('menu').first()
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'Rename…' })).toBeVisible()
  })

  // ────────────────────────────────────────────────────────────────────────
  // QA-added regression guards (validation, cancel paths, ⋯ button flow,
  // focus restoration, end-to-end sticky label after OSC emissions).
  // ────────────────────────────────────────────────────────────────────────

  test('rename validation rejects empty / whitespace-only labels', async () => {
    await spawnClaudeTab()

    const claudeTab = window.locator('button:has-text("Claude")').first()
    await claudeTab.click({ button: 'right' })
    await window.getByRole('menuitem', { name: 'Rename…' }).click()

    const dialog = window.getByRole('dialog', { name: 'Rename tab' })
    await expect(dialog).toBeVisible()

    const input = dialog.getByRole('textbox')
    await input.fill('   ') // whitespace-only

    // PromptModal disables submit when the validator returns a non-null error.
    await expect(dialog.getByRole('button', { name: 'Rename' })).toBeDisabled()

    await window.keyboard.press('Escape')
    await expect(dialog).not.toBeVisible()
    await expect(window.locator('button:has-text("Claude")').first()).toBeVisible()
  })

  test('Cancel on the rename modal does not change the label', async () => {
    await spawnClaudeTab()

    const claudeTab = window.locator('button:has-text("Claude")').first()
    await claudeTab.click({ button: 'right' })
    await window.getByRole('menuitem', { name: 'Rename…' }).click()

    const dialog = window.getByRole('dialog', { name: 'Rename tab' })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('textbox').fill('Will Not Stick')

    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).not.toBeVisible()

    await expect(window.locator('button:has-text("Will Not Stick")')).toHaveCount(0)
    await expect(window.locator('button:has-text("Claude")').first()).toBeVisible()
  })

  test('Esc on the rename modal does not change the label', async () => {
    await spawnClaudeTab()

    const claudeTab = window.locator('button:has-text("Claude")').first()
    await claudeTab.click({ button: 'right' })
    await window.getByRole('menuitem', { name: 'Rename…' }).click()

    const dialog = window.getByRole('dialog', { name: 'Rename tab' })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('textbox').fill('Also Will Not Stick')

    await window.keyboard.press('Escape')
    await expect(dialog).not.toBeVisible()

    await expect(window.locator('button:has-text("Also Will Not Stick")')).toHaveCount(0)
    await expect(window.locator('button:has-text("Claude")').first()).toBeVisible()
  })

  test('⋯ button on a Claude tab opens the same menu', async () => {
    await spawnClaudeTab()

    const claudeTab = window.locator('button:has-text("Claude")').first()
    // Hover the tab to reveal the ⋯ button (it's opacity-0 by default).
    await claudeTab.hover()

    const overflowBtn = claudeTab.getByRole('button', { name: 'Tab options' })
    await expect(overflowBtn).toBeVisible({ timeout: 5_000 })
    await overflowBtn.click()

    const menu = window.getByRole('menu').first()
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'Rename…' })).toBeVisible()
  })

  test('Esc from menu opened via ⋯ returns focus to the ⋯ button', async () => {
    await spawnClaudeTab()

    const claudeTab = window.locator('button:has-text("Claude")').first()
    await claudeTab.hover()
    const overflowBtn = claudeTab.getByRole('button', { name: 'Tab options' })
    await overflowBtn.click()

    const menu = window.getByRole('menu').first()
    await expect(menu).toBeVisible()

    await window.keyboard.press('Escape')
    await expect(menu).not.toBeVisible()

    const focusedAriaLabel = await window.evaluate(
      () => document.activeElement?.getAttribute('aria-label')
    )
    expect(focusedAriaLabel).toBe('Tab options')
  })

  test('after a rename, the OSC title-change handler does not overwrite the custom label', async () => {
    await spawnClaudeTab()

    const claudeTab = window.locator('button:has-text("Claude")').first()
    await claudeTab.click({ button: 'right' })
    await window.getByRole('menuitem', { name: 'Rename…' }).click()

    const dialog = window.getByRole('dialog', { name: 'Rename tab' })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('textbox').fill('My Project')
    await dialog.getByRole('button', { name: 'Rename' }).click()
    await expect(dialog).not.toBeVisible()

    await expect(window.locator('button:has-text("My Project")').first()).toBeVisible({ timeout: 5_000 })

    // Wait long enough for any OSC title emission from the PTY's startup
    // (shell prompt, etc.) to fire. The sticky-label guard must hold.
    await window.waitForTimeout(2_000)

    await expect(window.locator('button:has-text("My Project")').first()).toBeVisible()

    // Strict assertion: no tab button (draggable=true) shows a "Claude" or
    // "Claude N" label — the renamed tab is the only Claude-kind tab.
    const claudeNumberedTabs = await window
      .locator('button[draggable="true"] span')
      .filter({ hasText: /^Claude(\s+\d+)?$/ })
      .count()
    expect(claudeNumberedTabs).toBe(0)
  })
})
