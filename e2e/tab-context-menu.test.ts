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
    await expect(window.locator('[role="tab"]:has-text("Claude")').first()).toBeVisible({ timeout: 5_000 })
  }

  test('right-click a Claude tab opens menu with Rename and Close enabled; Fork is hidden (gate off)', async () => {
    await spawnClaudeTab()

    const claudeTab = window.locator('[role="tab"]:has-text("Claude")').first()
    await claudeTab.click({ button: 'right' })

    const menu = window.getByRole('menu').first()
    await expect(menu).toBeVisible()

    // Rename is enabled.
    const rename = menu.getByRole('menuitem', { name: 'Rename…' })
    await expect(rename).toBeVisible()
    await expect(rename).not.toBeDisabled()

    // Close session is enabled (PR2).
    const close = menu.getByRole('menuitem', { name: 'Close session' })
    await expect(close).toBeVisible()
    await expect(close).not.toBeDisabled()

    // Without SIMPLEEDIT_EXPERIMENTAL_FORK=1 the Fork item is hidden entirely.
    await expect(menu.getByRole('menuitem', { name: 'Fork into worktree…' })).toHaveCount(0)

    // Esc dismisses without action.
    await window.keyboard.press('Escape')
    await expect(menu).not.toBeVisible()
  })

  test('Rename… opens a PromptModal; submitting changes the tab label', async () => {
    await spawnClaudeTab()

    const claudeTab = window.locator('[role="tab"]:has-text("Claude")').first()
    await claudeTab.click({ button: 'right' })
    await window.getByRole('menuitem', { name: 'Rename…' }).click()

    const dialog = window.getByRole('dialog', { name: 'Rename tab' })
    await expect(dialog).toBeVisible()

    const input = dialog.getByRole('textbox')
    await expect(input).toBeFocused()
    await input.fill('My experiment')
    await dialog.getByRole('button', { name: 'Rename' }).click()

    await expect(dialog).not.toBeVisible()
    await expect(window.locator('[role="tab"]:has-text("My experiment")').first()).toBeVisible()
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

    const claudeTab = window.locator('[role="tab"]:has-text("Claude")').first()
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

    const claudeTab = window.locator('[role="tab"]:has-text("Claude")').first()
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
    await expect(window.locator('[role="tab"]:has-text("Claude")').first()).toBeVisible()
  })

  test('Cancel on the rename modal does not change the label', async () => {
    await spawnClaudeTab()

    const claudeTab = window.locator('[role="tab"]:has-text("Claude")').first()
    await claudeTab.click({ button: 'right' })
    await window.getByRole('menuitem', { name: 'Rename…' }).click()

    const dialog = window.getByRole('dialog', { name: 'Rename tab' })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('textbox').fill('Will Not Stick')

    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).not.toBeVisible()

    await expect(window.locator('[role="tab"]:has-text("Will Not Stick")')).toHaveCount(0)
    await expect(window.locator('[role="tab"]:has-text("Claude")').first()).toBeVisible()
  })

  test('Esc on the rename modal does not change the label', async () => {
    await spawnClaudeTab()

    const claudeTab = window.locator('[role="tab"]:has-text("Claude")').first()
    await claudeTab.click({ button: 'right' })
    await window.getByRole('menuitem', { name: 'Rename…' }).click()

    const dialog = window.getByRole('dialog', { name: 'Rename tab' })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('textbox').fill('Also Will Not Stick')

    await window.keyboard.press('Escape')
    await expect(dialog).not.toBeVisible()

    await expect(window.locator('[role="tab"]:has-text("Also Will Not Stick")')).toHaveCount(0)
    await expect(window.locator('[role="tab"]:has-text("Claude")').first()).toBeVisible()
  })

  test('⋯ button on a Claude tab opens the same menu', async () => {
    await spawnClaudeTab()

    const claudeTab = window.locator('[role="tab"]:has-text("Claude")').first()
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

    const claudeTab = window.locator('[role="tab"]:has-text("Claude")').first()
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

    const claudeTab = window.locator('[role="tab"]:has-text("Claude")').first()
    await claudeTab.click({ button: 'right' })
    await window.getByRole('menuitem', { name: 'Rename…' }).click()

    const dialog = window.getByRole('dialog', { name: 'Rename tab' })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('textbox').fill('My Project')
    await dialog.getByRole('button', { name: 'Rename' }).click()
    await expect(dialog).not.toBeVisible()

    await expect(window.locator('[role="tab"]:has-text("My Project")').first()).toBeVisible({ timeout: 5_000 })

    // Wait long enough for any OSC title emission from the PTY's startup
    // (shell prompt, etc.) to fire. The sticky-label guard must hold.
    await window.waitForTimeout(2_000)

    await expect(window.locator('[role="tab"]:has-text("My Project")').first()).toBeVisible()

    // Strict assertion: no tab (role="tab", draggable=true) shows a "Claude"
    // or "Claude N" label — the renamed tab is the only Claude-kind tab.
    const claudeNumberedTabs = await window
      .locator('[role="tab"][draggable="true"] span')
      .filter({ hasText: /^Claude(\s+\d+)?$/ })
      .count()
    expect(claudeNumberedTabs).toBe(0)
  })

  // ────────────────────────────────────────────────────────────────────────
  // PR2: Close session menu item
  // ────────────────────────────────────────────────────────────────────────

  test('Close session menu item closes the tab', async () => {
    // Spawn two Claude tabs so closing one leaves something behind.
    await spawnClaudeTab()
    const claudeButton = window.getByRole('button', { name: 'Run Claude Code' }).first()
    await claudeButton.click()
    await expect(window.locator('button:has-text("Claude 2")').first()).toBeVisible({ timeout: 5_000 })

    // Right-click the second Claude tab → Close session.
    const claude2 = window.locator('button:has-text("Claude 2")').first()
    await claude2.click({ button: 'right' })
    await window.getByRole('menuitem', { name: 'Close session' }).click()

    // The Claude 2 tab disappears; the first Claude tab survives.
    await expect(window.locator('button:has-text("Claude 2")')).toHaveCount(0, { timeout: 5_000 })
    await expect(window.locator('button:has-text("Claude")').first()).toBeVisible()
  })

  test('Close session keyboard activation (Enter) closes the tab', async () => {
    await spawnClaudeTab()
    const claudeButton = window.getByRole('button', { name: 'Run Claude Code' }).first()
    await claudeButton.click()
    await expect(window.locator('button:has-text("Claude 2")').first()).toBeVisible({ timeout: 5_000 })

    const claude2 = window.locator('button:has-text("Claude 2")').first()
    await claude2.focus()
    await window.keyboard.press('Shift+F10')

    const menu = window.getByRole('menu').first()
    await expect(menu).toBeVisible()

    // Initial focus lands on Rename (first enabled, since Fork is disabled).
    // ArrowDown → Close (next enabled). Enter activates.
    // NOTE for PR3: when Fork becomes enabled, initial focus moves to Fork
    // and this needs two ArrowDowns to reach Close.
    await window.keyboard.press('ArrowDown')
    await window.keyboard.press('Enter')

    await expect(window.locator('button:has-text("Claude 2")')).toHaveCount(0, { timeout: 5_000 })
  })

  test('Close session on Agent View tab closes it without trying to detach a stream parser', async () => {
    // Open an Agent View tab via the ✦ button context menu, then close it.
    const claudeButton = window.getByRole('button', { name: 'Run Claude Code' }).first()
    await claudeButton.click({ button: 'right' })
    await window.getByRole('menuitem', { name: 'New Agent View session' }).click()
    await expect(window.locator('button:has-text("Agents")').first()).toBeVisible({ timeout: 5_000 })

    const agents = window.locator('button:has-text("Agents")').first()
    await agents.click({ button: 'right' })
    await window.getByRole('menuitem', { name: 'Close session' }).click()

    await expect(window.locator('button:has-text("Agents")')).toHaveCount(0, { timeout: 5_000 })
  })

  // ────────────────────────────────────────────────────────────────────────
  // PR2 QA additions: Close-menu edge cases (Esc, last-tab cleanup, legacy ×).
  // ────────────────────────────────────────────────────────────────────────

  test('Esc on the menu does not close the tab', async () => {
    await spawnClaudeTab()

    const claudeTab = window.locator('button:has-text("Claude")').first()
    await claudeTab.click({ button: 'right' })

    const menu = window.getByRole('menu').first()
    await expect(menu).toBeVisible()

    await window.keyboard.press('Escape')
    await expect(menu).not.toBeVisible()

    // Tab survives.
    await expect(window.locator('button:has-text("Claude")').first()).toBeVisible()
  })

  test('closing the only Claude tab leaves the plain terminal tab and ✦ still works', async () => {
    await spawnClaudeTab()

    const claudeTab = window.locator('button:has-text("Claude")').first()
    await claudeTab.click({ button: 'right' })
    await window.getByRole('menuitem', { name: 'Close session' }).click()

    // Claude tab disappears (excluding the "Run Claude Code" ✦ button).
    await expect(
      window.locator('button:has-text("Claude")').filter({ hasNotText: 'Run Claude Code' })
    ).toHaveCount(0, { timeout: 5_000 })

    // The plain "Terminal 1" tab (created on mount) is still there.
    await expect(window.locator('button:has-text("Terminal 1")').first()).toBeVisible()

    // ✦ button still works — spawn another Claude session.
    const claudeButton = window.getByRole('button', { name: 'Run Claude Code' }).first()
    await claudeButton.click()
    await expect(
      window
        .locator('button:has-text("Claude")')
        .filter({ hasNotText: 'Run Claude Code' })
        .first()
    ).toBeVisible({ timeout: 5_000 })
  })

  test('legacy × close button on a Claude tab still works after Close session is wired', async () => {
    await spawnClaudeTab()
    const claudeButton = window.getByRole('button', { name: 'Run Claude Code' }).first()
    await claudeButton.click()
    await expect(window.locator('button:has-text("Claude 2")').first()).toBeVisible({ timeout: 5_000 })

    // Click the × inside Claude 2 (legacy close affordance, sibling of ⋯ inside the tab button).
    const claude2 = window.locator('button:has-text("Claude 2")').first()
    await claude2.hover()
    const closeX = claude2.locator('span[role="button"]').filter({ hasText: /^x$/ }).first()
    await closeX.click()

    await expect(window.locator('button:has-text("Claude 2")')).toHaveCount(0, { timeout: 5_000 })
    // The first Claude tab survives.
    await expect(
      window
        .locator('button:has-text("Claude")')
        .filter({ hasNotText: 'Run Claude Code' })
        .first()
    ).toBeVisible()
  })
})

// ────────────────────────────────────────────────────────────────────────────
// PR3 (#87 fork gate): with SIMPLEEDIT_EXPERIMENTAL_FORK=1 the Fork item
// appears in the menu, disabled today with a tooltip pointing at task #10 /
// issue #95. Execution will follow once session-id capture lands.
// ────────────────────────────────────────────────────────────────────────────

test.describe('Issue #87 PR3: experimental-fork gate', () => {
  let testRoot: string
  let bareRepoPath: string
  let app: ElectronApplication
  let window: Page

  test.beforeAll(() => {
    testRoot = mkdtempSync(join(tmpdir(), 'simpleedit-issue87-pr3-'))
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
      env: {
        ...process.env,
        SIMPLEEDIT_REPO: bareRepoPath,
        SIMPLEEDIT_EXPERIMENTAL_FORK: '1',
      },
    })
    window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    interface ApiOnly { api: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> } }
    await window.evaluate(
      async (r) => (window as unknown as ApiOnly).api.invoke('session:clear', r),
      bareRepoPath,
    )
  })

  test.afterEach(async () => {
    await app.close()
  })

  async function spawnClaudeTab(): Promise<void> {
    const claudeButton = window.getByRole('button', { name: 'Run Claude Code' }).first()
    await expect(claudeButton).toBeVisible({ timeout: 10_000 })
    await claudeButton.click()
    await expect(window.locator('button:has-text("Claude")').first()).toBeVisible({ timeout: 5_000 })
  }

  test('Fork item appears in the menu when SIMPLEEDIT_EXPERIMENTAL_FORK=1', async () => {
    await spawnClaudeTab()
    const claudeTab = window.locator('button:has-text("Claude")').first()
    await claudeTab.click({ button: 'right' })

    const menu = window.getByRole('menu').first()
    await expect(menu).toBeVisible()

    const fork = menu.getByRole('menuitem', { name: 'Fork into worktree…' })
    await expect(fork).toBeVisible()
  })

  test('Fork item is disabled with a tooltip pointing at issue #95 / task #10', async () => {
    await spawnClaudeTab()
    const claudeTab = window.locator('button:has-text("Claude")').first()
    await claudeTab.click({ button: 'right' })

    const fork = window.getByRole('menu').first().getByRole('menuitem', { name: 'Fork into worktree…' })
    await expect(fork).toBeDisabled()
    await expect(fork).toHaveAttribute(
      'title',
      'Fork requires Claude session-id capture (see issue #95 / task #10)',
    )
  })

  test('clicking the disabled Fork item is a no-op', async () => {
    await spawnClaudeTab()
    const claudeTab = window.locator('button:has-text("Claude")').first()
    await claudeTab.click({ button: 'right' })

    const fork = window.getByRole('menu').first().getByRole('menuitem', { name: 'Fork into worktree…' })
    await fork.click({ force: true }) // force = bypass disabled-guard so we exercise the click path

    // No "Forking…" placeholder tab should appear (the future success-state UI).
    await expect(window.locator('button:has-text("Forking")')).toHaveCount(0)
    // No menu transitioning to a worktree picker (a feature PR4 will add).
    await expect(window.locator('text=Select worktree')).toHaveCount(0)
  })

  test('the gate does not affect Rename or Close session', async () => {
    await spawnClaudeTab()
    const claudeTab = window.locator('button:has-text("Claude")').first()
    await claudeTab.click({ button: 'right' })

    const menu = window.getByRole('menu').first()
    await expect(menu.getByRole('menuitem', { name: 'Rename…' })).not.toBeDisabled()
    await expect(menu.getByRole('menuitem', { name: 'Close session' })).not.toBeDisabled()
  })
})

// ────────────────────────────────────────────────────────────────────────────
// PR3 QA additions: gate edge cases that need per-test launch env control
// (multi-relaunch, alternate env values, Agent View tab parity).
// ────────────────────────────────────────────────────────────────────────────

test.describe('Issue #87 PR3 QA — gate edge cases', () => {
  let testRoot: string
  let bareRepoPath: string
  let app: ElectronApplication | undefined
  let window: Page | undefined

  test.beforeAll(() => {
    testRoot = mkdtempSync(join(tmpdir(), 'simpleedit-issue87-pr3-qa-'))
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

  async function launch(envExtras: Record<string, string | undefined>): Promise<void> {
    app = await electron.launch({
      args: [MAIN, ...SANDBOX_ARGS],
      env: { ...process.env, SIMPLEEDIT_REPO: bareRepoPath, ...envExtras },
    })
    window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    interface ApiOnly { api: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> } }
    await window.evaluate(
      async (r) => (window as unknown as ApiOnly).api.invoke('session:clear', r),
      bareRepoPath,
    )
  }

  test.afterEach(async () => {
    if (app) {
      await app.close()
      app = undefined
      window = undefined
    }
  })

  async function spawnClaudeTab(w: Page): Promise<void> {
    const claudeButton = w.getByRole('button', { name: 'Run Claude Code' }).first()
    await expect(claudeButton).toBeVisible({ timeout: 10_000 })
    await claudeButton.click()
    await expect(w.locator('button:has-text("Claude")').first()).toBeVisible({ timeout: 5_000 })
  }

  test('Fork item also appears (disabled) on Agent View tabs when gate is ON', async () => {
    await launch({ SIMPLEEDIT_EXPERIMENTAL_FORK: '1' })
    const w = window!

    const claudeButton = w.getByRole('button', { name: 'Run Claude Code' }).first()
    await claudeButton.click({ button: 'right' })
    await w.getByRole('menuitem', { name: 'New Agent View session' }).click()

    const agentsTab = w.locator('button:has-text("Agents")').first()
    await expect(agentsTab).toBeVisible({ timeout: 5_000 })

    await agentsTab.click({ button: 'right' })
    const menu = w.getByRole('menu').first()
    await expect(menu).toBeVisible()

    const fork = menu.getByRole('menuitem', { name: 'Fork into worktree…' })
    await expect(fork).toBeVisible()
    await expect(fork).toBeDisabled()
    // Same generic tooltip in PR3; PR4 may differentiate for Agent View.
    await expect(fork).toHaveAttribute(
      'title',
      'Fork requires Claude session-id capture (see issue #95 / task #10)',
    )
  })

  test('app:experimental-fork IPC returns true when env=1 and false otherwise', async () => {
    interface ApiOnly { api: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> } }

    await launch({ SIMPLEEDIT_EXPERIMENTAL_FORK: '1' })
    const onResult = await window!.evaluate(
      () => (window as unknown as ApiOnly).api.invoke('app:experimental-fork'),
    )
    expect(onResult).toBe(true)

    await app!.close()
    app = undefined
    window = undefined

    await launch({ SIMPLEEDIT_EXPERIMENTAL_FORK: undefined })
    const offResult = await window!.evaluate(
      () => (window as unknown as ApiOnly).api.invoke('app:experimental-fork'),
    )
    expect(offResult).toBe(false)
  })

  test('non-"1" gate values keep the Fork item hidden', async () => {
    // "true" is the obvious mistaken value users might try. Strict === '1' check rejects it.
    await launch({ SIMPLEEDIT_EXPERIMENTAL_FORK: 'true' })
    const w = window!
    await spawnClaudeTab(w)

    const claudeTab = w.locator('button:has-text("Claude")').first()
    await claudeTab.click({ button: 'right' })
    const menu = w.getByRole('menu').first()
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'Fork into worktree…' })).toHaveCount(0)
    await expect(menu.getByRole('menuitem', { name: 'Rename…' })).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'Close session' })).toBeVisible()
  })

  test('Shift+F10 + Enter activates Rename (first ENABLED item), not the disabled Fork', async () => {
    await launch({ SIMPLEEDIT_EXPERIMENTAL_FORK: '1' })
    const w = window!
    await spawnClaudeTab(w)

    const claudeTab = w.locator('button:has-text("Claude")').first()
    await claudeTab.focus()
    await w.keyboard.press('Shift+F10')

    const menu = w.getByRole('menu').first()
    await expect(menu).toBeVisible()

    // Initial focus lands on Rename (first ENABLED — Fork is disabled). Enter opens the modal.
    await w.keyboard.press('Enter')

    const dialog = w.getByRole('dialog', { name: 'Rename tab' })
    await expect(dialog).toBeVisible()

    // Tidy up so afterEach can close cleanly.
    await w.keyboard.press('Escape')
    await expect(dialog).not.toBeVisible()
  })
})
