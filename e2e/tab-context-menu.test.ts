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
 * Issue #87 (PR1, ported to agent-first UI): right-click a Claude session in
 * the SessionList → context menu with Rename / Fork / Close session. Rename
 * submits via PromptModal; the new label is sticky (not overwritten by xterm
 * OSC titles) and persists across session save/load.
 *
 * In the agent-first UI sessions are role="option" entries in the sidebar
 * SessionList (was role="tab" in the old per-pane terminal strip); the spawn
 * button is "New Claude session", the ⋯ menu button is "Session options", the
 * × is "Close session", and the rename dialog is titled "Rename session".
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
    await waitForWorktreesReady(window)
  })

  test.afterEach(async () => {
    await app.close()
  })

  // Helper: spawn a Claude tab via the ✦ button's left-click.
  async function spawnClaudeTab(): Promise<void> {
    const claudeButton = window.getByRole('button', { name: 'New Claude session' }).first()
    await expect(claudeButton).toBeVisible({ timeout: 10_000 })
    await claudeButton.click()
    await expect(window.locator('[role="option"]:has-text("Claude")').first()).toBeVisible({ timeout: 5_000 })
  }

  test('right-click a Claude tab opens menu with Rename, Close, and Fork items', async () => {
    await spawnClaudeTab()

    const claudeTab = window.locator('[role="option"]:has-text("Claude")').first()
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

    // Fork is always visible; disabled state depends on per-tab session-id capture.
    await expect(menu.getByRole('menuitem', { name: 'Fork into worktree…' })).toBeVisible()

    // Esc dismisses without action.
    await window.keyboard.press('Escape')
    await expect(menu).not.toBeVisible()
  })

  test('Rename… opens a PromptModal; submitting changes the tab label', async () => {
    await spawnClaudeTab()

    const claudeTab = window.locator('[role="option"]:has-text("Claude")').first()
    await claudeTab.click({ button: 'right' })
    await window.getByRole('menuitem', { name: 'Rename…' }).click()

    const dialog = window.getByRole('dialog', { name: 'Rename session' })
    await expect(dialog).toBeVisible()

    const input = dialog.getByRole('textbox')
    await expect(input).toBeFocused()
    await input.fill('My experiment')
    await dialog.getByRole('button', { name: 'Rename' }).click()

    await expect(dialog).not.toBeVisible()
    await expect(window.locator('[role="option"]:has-text("My experiment")').first()).toBeVisible()
  })

  test('user-set label survives a session save/load round-trip via customLabel', async () => {
    interface ApiOnly { api: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> } }

    const worktreePath = join(testRoot, 'main')
    const payload = {
      version: 2,
      repoPath: bareRepoPath,
      savedAt: new Date().toISOString(),
      sessions: [
        { kind: 'claude', label: 'My experiment', sessionId: 'sid-1', customLabel: true, worktreePath, tabs: [], activeTabId: null, unread: [] },
        { kind: 'agents', label: 'Agents', customLabel: true, worktreePath, tabs: [], activeTabId: null, unread: [] },
        { kind: 'claude', label: 'untouched', sessionId: 'sid-2', worktreePath, tabs: [], activeTabId: null, unread: [] },
      ],
      activeIndex: 0,
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
    const sessions = loaded!.sessions

    const renamed = sessions.find((s) => s.label === 'My experiment')!
    expect(renamed.customLabel).toBe(true)
    expect(renamed.sessionId).toBe('sid-1')

    const agentsRenamed = sessions.find((s) => s.label === 'Agents')!
    expect(agentsRenamed.customLabel).toBe(true)
    expect(agentsRenamed.kind).toBe('agents')

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

    const claudeTab = window.locator('[role="option"]:has-text("Claude")').first()
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

    const claudeTab = window.locator('[role="option"]:has-text("Claude")').first()
    await claudeTab.click({ button: 'right' })
    await window.getByRole('menuitem', { name: 'Rename…' }).click()

    const dialog = window.getByRole('dialog', { name: 'Rename session' })
    await expect(dialog).toBeVisible()

    const input = dialog.getByRole('textbox')
    await input.fill('   ') // whitespace-only

    // PromptModal disables submit when the validator returns a non-null error.
    await expect(dialog.getByRole('button', { name: 'Rename' })).toBeDisabled()

    await window.keyboard.press('Escape')
    await expect(dialog).not.toBeVisible()
    await expect(window.locator('[role="option"]:has-text("Claude")').first()).toBeVisible()
  })

  test('Cancel on the rename modal does not change the label', async () => {
    await spawnClaudeTab()

    const claudeTab = window.locator('[role="option"]:has-text("Claude")').first()
    await claudeTab.click({ button: 'right' })
    await window.getByRole('menuitem', { name: 'Rename…' }).click()

    const dialog = window.getByRole('dialog', { name: 'Rename session' })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('textbox').fill('Will Not Stick')

    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).not.toBeVisible()

    await expect(window.locator('[role="option"]:has-text("Will Not Stick")')).toHaveCount(0)
    await expect(window.locator('[role="option"]:has-text("Claude")').first()).toBeVisible()
  })

  test('Esc on the rename modal does not change the label', async () => {
    await spawnClaudeTab()

    const claudeTab = window.locator('[role="option"]:has-text("Claude")').first()
    await claudeTab.click({ button: 'right' })
    await window.getByRole('menuitem', { name: 'Rename…' }).click()

    const dialog = window.getByRole('dialog', { name: 'Rename session' })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('textbox').fill('Also Will Not Stick')

    await window.keyboard.press('Escape')
    await expect(dialog).not.toBeVisible()

    await expect(window.locator('[role="option"]:has-text("Also Will Not Stick")')).toHaveCount(0)
    await expect(window.locator('[role="option"]:has-text("Claude")').first()).toBeVisible()
  })

  test('⋯ button on a Claude tab opens the same menu', async () => {
    await spawnClaudeTab()

    const claudeTab = window.locator('[role="option"]:has-text("Claude")').first()
    // Hover the tab to reveal the ⋯ button (it's opacity-0 by default).
    await claudeTab.hover()

    const overflowBtn = claudeTab.getByRole('button', { name: 'Session options' })
    await expect(overflowBtn).toBeVisible({ timeout: 5_000 })
    await overflowBtn.click()

    const menu = window.getByRole('menu').first()
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'Rename…' })).toBeVisible()
  })

  test('Esc from menu opened via ⋯ returns focus to the ⋯ button', async () => {
    await spawnClaudeTab()

    const claudeTab = window.locator('[role="option"]:has-text("Claude")').first()
    await claudeTab.hover()
    const overflowBtn = claudeTab.getByRole('button', { name: 'Session options' })
    await overflowBtn.click()

    const menu = window.getByRole('menu').first()
    await expect(menu).toBeVisible()

    await window.keyboard.press('Escape')
    await expect(menu).not.toBeVisible()

    const focusedAriaLabel = await window.evaluate(
      () => document.activeElement?.getAttribute('aria-label')
    )
    expect(focusedAriaLabel).toBe('Session options')
  })

  test('after a rename, the OSC title-change handler does not overwrite the custom label', async () => {
    await spawnClaudeTab()

    const claudeTab = window.locator('[role="option"]:has-text("Claude")').first()
    await claudeTab.click({ button: 'right' })
    await window.getByRole('menuitem', { name: 'Rename…' }).click()

    const dialog = window.getByRole('dialog', { name: 'Rename session' })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('textbox').fill('My Project')
    await dialog.getByRole('button', { name: 'Rename' }).click()
    await expect(dialog).not.toBeVisible()

    await expect(window.locator('[role="option"]:has-text("My Project")').first()).toBeVisible({ timeout: 5_000 })

    // Wait long enough for any OSC title emission from the PTY's startup
    // (shell prompt, etc.) to fire. The sticky-label guard must hold.
    await window.waitForTimeout(2_000)

    await expect(window.locator('[role="option"]:has-text("My Project")').first()).toBeVisible()

    // Strict assertion: no session entry shows a bare "Claude" / "Claude N"
    // label — the renamed session is the only Claude-kind entry. Match the
    // label span exactly (the option also renders a worktree-branch sub-line).
    const claudeNumberedTabs = await window
      .locator('[role="option"] span.truncate')
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
    const claudeButton = window.getByRole('button', { name: 'New Claude session' }).first()
    await claudeButton.click()
    await expect(window.locator('[role="option"]:has-text("Claude 2")').first()).toBeVisible({ timeout: 5_000 })

    // Right-click the second Claude tab → Close session.
    const claude2 = window.locator('[role="option"]:has-text("Claude 2")').first()
    await claude2.click({ button: 'right' })
    await window.getByRole('menuitem', { name: 'Close session' }).click()

    // The Claude 2 tab disappears; the first Claude tab survives.
    await expect(window.locator('[role="option"]:has-text("Claude 2")')).toHaveCount(0, { timeout: 5_000 })
    await expect(window.locator('[role="option"]:has-text("Claude")').first()).toBeVisible()
  })

  test('Close session keyboard activation (Enter) closes the tab', async () => {
    await spawnClaudeTab()
    const claudeButton = window.getByRole('button', { name: 'New Claude session' }).first()
    await claudeButton.click()
    await expect(window.locator('[role="option"]:has-text("Claude 2")').first()).toBeVisible({ timeout: 5_000 })

    const claude2 = window.locator('[role="option"]:has-text("Claude 2")').first()
    await claude2.focus()
    await window.keyboard.press('Shift+F10')

    const menu = window.getByRole('menu').first()
    await expect(menu).toBeVisible()

    // Menu order: Fork, Rename, Close. Post-#102 Fork is enabled (session-id
    // captured synchronously at spawn) and post-gate-removal it's always
    // visible, so initial focus lands on Fork. ArrowDown → Rename. ArrowDown
    // → Close. Enter activates Close.
    await window.keyboard.press('ArrowDown')
    await window.keyboard.press('ArrowDown')
    await window.keyboard.press('Enter')

    await expect(window.locator('[role="option"]:has-text("Claude 2")')).toHaveCount(0, { timeout: 5_000 })
  })

  test('Close session on Agent View tab closes it without trying to detach a stream parser', async () => {
    // Open an Agent View tab via the ✦ button context menu, then close it.
    const claudeButton = window.getByRole('button', { name: 'New Claude session' }).first()
    await claudeButton.click({ button: 'right' })
    await window.getByRole('menuitem', { name: 'New Agent View session' }).click()
    await expect(window.locator('[role="option"]:has-text("Agents")').first()).toBeVisible({ timeout: 5_000 })

    const agents = window.locator('[role="option"]:has-text("Agents")').first()
    await agents.click({ button: 'right' })
    await window.getByRole('menuitem', { name: 'Close session' }).click()

    await expect(window.locator('[role="option"]:has-text("Agents")')).toHaveCount(0, { timeout: 5_000 })
  })

  // ────────────────────────────────────────────────────────────────────────
  // PR2 QA additions: Close-menu edge cases (Esc, last-tab cleanup, legacy ×).
  // ────────────────────────────────────────────────────────────────────────

  test('Esc on the menu does not close the tab', async () => {
    await spawnClaudeTab()

    const claudeTab = window.locator('[role="option"]:has-text("Claude")').first()
    await claudeTab.click({ button: 'right' })

    const menu = window.getByRole('menu').first()
    await expect(menu).toBeVisible()

    await window.keyboard.press('Escape')
    await expect(menu).not.toBeVisible()

    // Tab survives.
    await expect(window.locator('[role="option"]:has-text("Claude")').first()).toBeVisible()
  })

  test('closing the only Claude session leaves a terminal session and ✦ still works', async () => {
    // The agent-first UI no longer auto-spawns a default terminal, so create
    // one explicitly via the "+ Term" button (title="New terminal") before
    // closing the Claude session.
    await window.getByTitle('New terminal').first().click()
    await expect(window.locator('[role="option"]:has-text("Terminal 1")').first()).toBeVisible({ timeout: 5_000 })

    await spawnClaudeTab()

    const claudeTab = window.locator('[role="option"]:has-text("Claude")').first()
    await claudeTab.click({ button: 'right' })
    await window.getByRole('menuitem', { name: 'Close session' }).click()

    // Claude session disappears ([role="option"] excludes the ✦ Agent button).
    await expect(window.locator('[role="option"]:has-text("Claude")')).toHaveCount(0, { timeout: 5_000 })

    // The terminal session survives.
    await expect(window.locator('[role="option"]:has-text("Terminal 1")').first()).toBeVisible()

    // ✦ Agent button still works — spawn another Claude session.
    const claudeButton = window.getByRole('button', { name: 'New Claude session' }).first()
    await claudeButton.click()
    await expect(
      window.locator('[role="option"]:has-text("Claude")').first()
    ).toBeVisible({ timeout: 5_000 })
  })

  test('legacy × close button on a Claude tab still works after Close session is wired', async () => {
    await spawnClaudeTab()
    const claudeButton = window.getByRole('button', { name: 'New Claude session' }).first()
    await claudeButton.click()
    await expect(window.locator('[role="option"]:has-text("Claude 2")').first()).toBeVisible({ timeout: 5_000 })

    // Click the × inside Claude 2 (close affordance, sibling of ⋯ inside the
    // session entry. Post-#97 it's a real <button aria-label="Close session">).
    const claude2 = window.locator('[role="option"]:has-text("Claude 2")').first()
    await claude2.hover()
    await claude2.getByRole('button', { name: 'Close session' }).click()

    await expect(window.locator('[role="option"]:has-text("Claude 2")')).toHaveCount(0, { timeout: 5_000 })
    // The first Claude tab survives.
    await expect(window.locator('[role="option"]:has-text("Claude")').first()).toBeVisible()
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Fork item disable behavior — in the Playwright environment without a real
// claude binary, the session-id is never captured, so the Fork item lands in
// the "waiting" disable state and clicking it is a no-op. (Originally PR3
// gate tests; the SIMPLEEDIT_EXPERIMENTAL_FORK gate was removed — Fork is now
// always visible, and these assertions describe the standard disabled-when-
// no-session-id behavior.)
// ────────────────────────────────────────────────────────────────────────────

test.describe('Fork item disable behavior', () => {
  let testRoot: string
  let bareRepoPath: string
  let app: ElectronApplication
  let window: Page

  test.beforeAll(() => {
    testRoot = mkdtempSync(join(tmpdir(), 'simpleedit-issue87-fork-disable-'))
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
      },
    })
    window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    interface ApiOnly { api: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> } }
    await window.evaluate(
      async (r) => (window as unknown as ApiOnly).api.invoke('session:clear', r),
      bareRepoPath,
    )
    await waitForWorktreesReady(window)
  })

  test.afterEach(async () => {
    await app.close()
  })

  async function spawnClaudeTab(): Promise<void> {
    const claudeButton = window.getByRole('button', { name: 'New Claude session' }).first()
    await expect(claudeButton).toBeVisible({ timeout: 10_000 })
    await claudeButton.click()
    await expect(window.locator('[role="option"]:has-text("Claude")').first()).toBeVisible({ timeout: 5_000 })
  }

  test('Fork item is enabled on a Claude tab once session-id is captured', async () => {
    // Post-#102, `claude:session-id` is minted synchronously in main on PTY
    // spawn (no need to scrape stream-json output), so a freshly-spawned
    // Claude tab has its session-id captured by the time the user can open
    // the context menu. Fork should therefore be enabled, not disabled.
    await spawnClaudeTab()
    const claudeTab = window.locator('[role="option"]:has-text("Claude")').first()
    await claudeTab.click({ button: 'right' })

    const fork = window.getByRole('menu').first().getByRole('menuitem', { name: 'Fork into worktree…' })
    await expect(fork).toBeVisible()
    await expect(fork).not.toBeDisabled()
  })

  // NOTE: the old test "clicking the disabled Fork item is a no-op" was deleted
  // in the agent-first port. Its premise — Fork is disabled until a session-id
  // is captured — no longer holds: claude:session-id is minted synchronously at
  // PTY spawn (see claude-session-id.test.ts), so on a freshly-spawned Claude
  // session Fork is already enabled (proven by the test above). There is no
  // disabled-Fork state left to exercise for a Claude session.

  test('typing a new name in the picker surfaces a "Create new worktree" row (#27)', async () => {
    await spawnClaudeTab()
    const claudeTab = window.locator('[role="option"]:has-text("Claude")').first()
    await claudeTab.click({ button: 'right' })

    // Open the worktree picker from the (enabled) Fork item.
    await window.getByRole('menu').first().getByRole('menuitem', { name: 'Fork into worktree…' }).click()

    const picker = window.getByRole('dialog', { name: 'Fork into worktree' })
    await expect(picker).toBeVisible({ timeout: 5_000 })

    // A name that doesn't match any existing worktree branch.
    await picker.getByPlaceholder('filter worktrees…').fill('totally-new-branch')

    const createRow = picker.getByRole('button', { name: /Create new worktree/ })
    await expect(createRow).toBeVisible()
    await expect(createRow).toContainText('totally-new-branch')
    await expect(createRow).toBeEnabled()
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Fork item parity / persistence: Agent View session disable-tooltip, keyboard
// nav past the Fork item, and Agent View entry round-trip through
// session:save/session:load (kind 'agents' preserved).
// ────────────────────────────────────────────────────────────────────────────

test.describe('Fork item parity and persistence', () => {
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

  async function launch(): Promise<void> {
    app = await electron.launch({
      args: [MAIN, ...SANDBOX_ARGS],
      env: { ...process.env, SIMPLEEDIT_REPO: bareRepoPath },
    })
    window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    interface ApiOnly { api: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> } }
    await window.evaluate(
      async (r) => (window as unknown as ApiOnly).api.invoke('session:clear', r),
      bareRepoPath,
    )
    await waitForWorktreesReady(window)
  }

  test.afterEach(async () => {
    if (app) {
      await app.close()
      app = undefined
      window = undefined
    }
  })

  async function spawnClaudeTab(w: Page): Promise<void> {
    const claudeButton = w.getByRole('button', { name: 'New Claude session' }).first()
    await expect(claudeButton).toBeVisible({ timeout: 10_000 })
    await claudeButton.click()
    await expect(w.locator('[role="option"]:has-text("Claude")').first()).toBeVisible({ timeout: 5_000 })
  }

  test('Agent View tabs show Fork disabled with the dedicated tooltip', async () => {
    await launch()
    const w = window!

    const claudeButton = w.getByRole('button', { name: 'New Claude session' }).first()
    await claudeButton.click({ button: 'right' })
    await w.getByRole('menuitem', { name: 'New Agent View session' }).click()

    const agentsTab = w.locator('[role="option"]:has-text("Agents")').first()
    await expect(agentsTab).toBeVisible({ timeout: 5_000 })

    await agentsTab.click({ button: 'right' })
    const menu = w.getByRole('menu').first()
    await expect(menu).toBeVisible()

    const fork = menu.getByRole('menuitem', { name: 'Fork into worktree…' })
    await expect(fork).toBeVisible()
    await expect(fork).toBeDisabled()
    // Agent View tabs get a dedicated tooltip so users understand the disable
    // is structural (the TUI emits no session id) rather than transient
    // (waiting for Claude to initialize).
    await expect(fork).toHaveAttribute('title', 'Agent View sessions cannot be forked')
  })

  test('Shift+F10 + ArrowDown + Enter activates Rename via keyboard nav', async () => {
    await launch()
    const w = window!
    await spawnClaudeTab(w)

    const claudeTab = w.locator('[role="option"]:has-text("Claude")').first()
    await claudeTab.focus()
    await w.keyboard.press('Shift+F10')

    const menu = w.getByRole('menu').first()
    await expect(menu).toBeVisible()

    // Menu order: Fork, Rename, Close. Post-#102 Fork is enabled (session-id
    // captured synchronously at spawn), so initial focus lands on Fork.
    // ArrowDown moves to Rename; Enter opens the modal.
    await w.keyboard.press('ArrowDown')
    await w.keyboard.press('Enter')

    const dialog = w.getByRole('dialog', { name: 'Rename session' })
    await expect(dialog).toBeVisible()

    // Tidy up so afterEach can close cleanly.
    await w.keyboard.press('Escape')
    await expect(dialog).not.toBeVisible()
  })

  // ──────────────────────────────────────────────────────────────────────
  // A restored Agent View session must keep kind 'agents' through save/load,
  // so the Fork item stays disabled with the dedicated tooltip — not the
  // generic "waiting…" one. Cross-restart half of the live parity test above.
  // ──────────────────────────────────────────────────────────────────────

  test('Agent View entries round-trip through session:save/session:load with kind preserved', async () => {
    // Storage-layer test: a SerializedSession (version 2) containing an Agent
    // View entry round-trips through disk with kind 'agents' intact (and no
    // sessionId), so the restored session keeps its Fork-disabled tooltip.
    interface ApiOnly { api: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> } }

    await launch()
    const liveWorktrees = (await window!.evaluate(() =>
      (window as unknown as ApiOnly).api.invoke('worktree:list'),
    )) as Array<{ path: string; branch: string }>
    const mainWorktree = liveWorktrees.find((w) => w.branch === 'main')
    expect(mainWorktree).toBeDefined()
    const worktreeMainPath = mainWorktree!.path

    const payload = {
      version: 2,
      repoPath: bareRepoPath,
      savedAt: new Date().toISOString(),
      sessions: [
        { kind: 'agents', label: 'Agents', customLabel: true, worktreePath: worktreeMainPath, tabs: [], activeTabId: null, unread: [] },
        { kind: 'claude', label: 'Claude', sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', worktreePath: worktreeMainPath, tabs: [], activeTabId: null, unread: [] },
      ],
      activeIndex: 1,
    }

    await window!.evaluate(
      async (p) => (window as unknown as ApiOnly).api.invoke('session:save', p),
      payload,
    )

    const loaded = (await window!.evaluate(
      async (r) => (window as unknown as ApiOnly).api.invoke('session:load', r),
      bareRepoPath,
    )) as typeof payload | null

    expect(loaded).not.toBeNull()
    const sessions = loaded!.sessions
    const agents = sessions.find((s) => s.label === 'Agents')!
    expect(agents.kind).toBe('agents')
    expect(agents.sessionId).toBeUndefined()
    // The Claude entry keeps kind 'claude' + its sessionId.
    const claude = sessions.find((s) => s.label === 'Claude')!
    expect(claude.kind).toBe('claude')
    expect(claude.sessionId).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')

    // Cleanup so we don't leave the saved session for later tests.
    await window!.evaluate(
      async (r) => (window as unknown as ApiOnly).api.invoke('session:clear', r),
      bareRepoPath,
    )
  })
})
