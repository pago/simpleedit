/**
 * E2E tests for Plan Mode, ported to the agent-first UI.
 *
 * Plan Mode changes vs the original suite:
 *  - GitLog (and its "✦ Plan" entry point) lives in the per-session workspace's
 *    right column, not the app sidebar. Tests spawn a Claude session and open
 *    the viewer first.
 *  - PlanView no longer replaces the pane; "✦ Plan" opens a PLAN TAB in the
 *    workspace tab bar (sticky, non-peek). There is no "← Back" button — tabs
 *    are closed/switched instead.
 *  - The plan notification toast is gone. plan:from-claude routes by session id
 *    and opens a tab directly (focused when the workspace is idle, background +
 *    unread when busy — the busy path is covered in tabs.test.ts).
 */
import { test, expect } from '@playwright/test'
import { _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { MAIN, launchEnv, spawnClaudeSession, openWorkspaceViewer, clearSavedSessionFile, createTempRepo, removeTempRepo } from './fixtures'

const SANDBOX_ARGS = process.env.CI ? ['--no-sandbox'] : []
const repoPath = process.env.SIMPLEEDIT_TEST_REPO

/** Click the first commit in the git log and wait for the diff tab. */
async function openFirstCommit(window: Page): Promise<void> {
  const commitList = window.locator('[role="listbox"][aria-label="Commits"]:visible')
  await expect(commitList).toBeVisible({ timeout: 10000 })
  const firstCommit = commitList.locator('[role="option"]').first()
  await expect(firstCommit).toBeVisible({ timeout: 5000 })
  await firstCommit.click()
  await window.waitForTimeout(1500)
}

/** Open the plan tab via the GitLog "✦ Plan" button in the workspace. */
async function openPlanTab(window: Page): Promise<void> {
  const planBtn = window.getByRole('button', { name: '✦ Plan' }).first()
  await expect(planBtn).toBeVisible({ timeout: 5000 })
  await planBtn.click()
  await window.waitForTimeout(500)
}

const planTabs = (window: Page) =>
  window.locator('[data-testid="worktree-tab"][data-kind="plan"]:visible')

const planTextarea = (window: Page) =>
  window.locator('textarea[placeholder*="Add user authentication"]:visible')

test.describe('Plan Mode — GitLog entry point', () => {
  test.skip(!repoPath, 'Set SIMPLEEDIT_TEST_REPO to run Plan Mode tests')

  let app: ElectronApplication
  let window: Page

  let repo: ReturnType<typeof createTempRepo>
  test.beforeAll(() => {
    repo = createTempRepo('simpleedit-e2e-')
  })
  test.afterAll(() => {
    removeTempRepo(repo)
  })

  test.beforeEach(async () => {
    clearSavedSessionFile(repo.bareRepoPath)
    app = await electron.launch({
      args: [MAIN, ...SANDBOX_ARGS],
      env: launchEnv({ SIMPLEEDIT_REPO: repo.bareRepoPath })
    })
    window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await spawnClaudeSession(window)
    await openWorkspaceViewer(window)
  })

  test.afterEach(async () => {
    await app.close()
  })

  test('Plan button appears in the workspace GitLog', async () => {
    await expect(window.getByRole('button', { name: '✦ Plan' }).first()).toBeVisible({
      timeout: 5000
    })
  })

  test('clicking Plan button opens a plan tab with text input', async () => {
    await openPlanTab(window)

    await expect(planTabs(window)).toHaveCount(1, { timeout: 5000 })
    await expect(planTabs(window).first()).toHaveAttribute('data-active', 'true')
    await expect(planTextarea(window)).toBeVisible({ timeout: 5000 })
  })

  test('closing the plan tab removes the plan view', async () => {
    // The old "← Back" button is gone — closing the tab is the way out.
    await openPlanTab(window)
    await expect(planTextarea(window)).toBeVisible({ timeout: 5000 })

    await planTabs(window).first().hover()
    await planTabs(window).first().getByTestId('worktree-tab-close').click()
    await window.waitForTimeout(500)

    await expect(planTabs(window)).toHaveCount(0)
    await expect(planTextarea(window)).not.toBeVisible({ timeout: 2000 })
  })

  test('Generate Plan button is disabled until text is entered', async () => {
    await openPlanTab(window)

    const generateBtn = window.locator('button:has-text("Generate Plan")')
    await expect(generateBtn.first()).toBeVisible({ timeout: 3000 })
    await expect(generateBtn.first()).toBeDisabled()

    // Type something
    await planTextarea(window).fill('Add a new feature')
    await window.waitForTimeout(200)

    await expect(generateBtn.first()).toBeEnabled()
  })

  test('plan tab shows description textarea', async () => {
    await openPlanTab(window)
    await expect(planTextarea(window)).toBeVisible({ timeout: 3000 })
  })
})

test.describe('Plan Mode — Lifecycle', () => {
  test.skip(!repoPath, 'Set SIMPLEEDIT_TEST_REPO to run Plan Mode tests')

  let app: ElectronApplication
  let window: Page

  let repo: ReturnType<typeof createTempRepo>
  test.beforeAll(() => {
    repo = createTempRepo('simpleedit-e2e-')
  })
  test.afterAll(() => {
    removeTempRepo(repo)
  })

  test.beforeEach(async () => {
    clearSavedSessionFile(repo.bareRepoPath)
    app = await electron.launch({
      args: [MAIN, ...SANDBOX_ARGS],
      env: launchEnv({ SIMPLEEDIT_REPO: repo.bareRepoPath })
    })
    window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await spawnClaudeSession(window)
    await openWorkspaceViewer(window)
  })

  test.afterEach(async () => {
    await app.close()
  })

  test('Plan reopens after closing the tab and clicking Plan again', async () => {
    // Open plan
    await openPlanTab(window)
    await expect(planTextarea(window)).toBeVisible({ timeout: 3000 })

    // Close the plan tab
    await planTabs(window).first().hover()
    await planTabs(window).first().getByTestId('worktree-tab-close').click()
    await window.waitForTimeout(500)
    await expect(planTabs(window)).toHaveCount(0)

    // Open plan again
    await openPlanTab(window)
    await expect(planTabs(window)).toHaveCount(1, { timeout: 3000 })
    await expect(planTextarea(window)).toBeVisible({ timeout: 3000 })
  })

  test('Plan refocuses after navigating to a commit and clicking Plan again', async () => {
    // Open plan first
    await openPlanTab(window)
    await expect(planTextarea(window)).toBeVisible({ timeout: 3000 })

    // Navigate to a commit — opens a diff tab; the plan tab is sticky and stays.
    await openFirstCommit(window)
    await expect(planTabs(window)).toHaveCount(1)

    // Clicking Plan again refocuses the existing plan tab (no duplicate).
    await openPlanTab(window)
    await expect(planTabs(window)).toHaveCount(1)
    await expect(planTabs(window).first()).toHaveAttribute('data-active', 'true')
    await expect(planTextarea(window)).toBeVisible({ timeout: 3000 })
  })

  test('multiple rapid Plan button clicks do not break the view', async () => {
    const planBtn = window.getByRole('button', { name: '✦ Plan' }).first()
    await expect(planBtn).toBeVisible({ timeout: 5000 })

    // Click rapidly
    await planBtn.click()
    await planBtn.click()
    await planBtn.click()
    await window.waitForTimeout(500)

    // Should still show exactly one plan tab with the textarea
    await expect(planTabs(window)).toHaveCount(1)
    await expect(planTextarea(window)).toBeVisible({ timeout: 3000 })
  })
})

test.describe('Plan Mode — Claude-originated plan', () => {
  test.skip(!repoPath, 'Set SIMPLEEDIT_TEST_REPO to run Plan Mode tests')

  let app: ElectronApplication
  let window: Page
  let sessionId: string

  let repo: ReturnType<typeof createTempRepo>
  test.beforeAll(() => {
    repo = createTempRepo('simpleedit-e2e-')
  })
  test.afterAll(() => {
    removeTempRepo(repo)
  })

  test.beforeEach(async () => {
    clearSavedSessionFile(repo.bareRepoPath)
    app = await electron.launch({
      args: [MAIN, ...SANDBOX_ARGS],
      env: launchEnv({ SIMPLEEDIT_REPO: repo.bareRepoPath })
    })
    window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    // Claude-originated plans route by session id — the workspace must exist.
    sessionId = await spawnClaudeSession(window)
  })

  test.afterEach(async () => {
    await app.close()
  })

  /** Get the active worktree path from the renderer. */
  async function getWorktreePath(): Promise<string> {
    return window.evaluate(() =>
      (window as unknown as { api: { invoke: (ch: string) => Promise<Array<{ path: string }>> } })
        .api.invoke('worktree:list').then((list) => list[0]?.path ?? '')
    )
  }

  /** Send a plan:from-claude IPC event addressed to the live session. */
  async function sendPlan(overview: string): Promise<void> {
    const wt = await getWorktreePath()
    await app.evaluate(
      ({ BrowserWindow }, { wt: worktreePath, tid, overview: ov }) => {
        const win = BrowserWindow.getAllWindows()[0]
        if (!win) return
        win.webContents.send('plan:from-claude', {
          key: `${worktreePath}:claude-${tid}`,
          terminalId: tid,
          plan: {
            overview: ov,
            tasks: [
              { id: 'e2e1', title: 'E2E Task', description: 'Test task', status: 'todo', reactions: [], discussion: [] }
            ]
          }
        })
      },
      { wt, tid: sessionId, overview }
    )
  }

  // NOTE: the old "plan notification toast appears" test was deleted in the
  // agent-first port. Toasts no longer exist — a plan arriving while the
  // workspace is busy opens a background tab with an unread marker instead
  // (covered by tabs.test.ts "agent-initiated tab opens in background…").

  test('Claude-originated plan auto-opens a focused plan tab when idle', async () => {
    await sendPlan('Viewable Plan')

    await expect(planTabs(window)).toHaveCount(1, { timeout: 5000 })
    await expect(planTabs(window).first()).toHaveAttribute('data-active', 'true')

    const indicator = window.locator('span:text-is("✦ From Claude session")')
    await expect(indicator).toBeVisible({ timeout: 5000 })
  })

  test('Send to Claude button appears for Claude-originated plans', async () => {
    await sendPlan('Feedback Plan')

    await expect(planTabs(window)).toHaveCount(1, { timeout: 5000 })

    const sendBtn = window.locator('button:has-text("Send to Claude")')
    await expect(sendBtn.first()).toBeVisible({ timeout: 5000 })
  })

  test('plan tab shows user-plan textarea when not from Claude', async () => {
    await openWorkspaceViewer(window)
    await openPlanTab(window)

    await expect(planTextarea(window)).toBeVisible({ timeout: 3000 })
  })
})

test.describe('Plan Mode — DiffReview left pane', () => {
  test.skip(!repoPath, 'Set SIMPLEEDIT_TEST_REPO to run Plan Mode tests')

  let app: ElectronApplication
  let window: Page

  let repo: ReturnType<typeof createTempRepo>
  test.beforeAll(() => {
    repo = createTempRepo('simpleedit-e2e-')
  })
  test.afterAll(() => {
    removeTempRepo(repo)
  })

  test.beforeEach(async () => {
    clearSavedSessionFile(repo.bareRepoPath)
    app = await electron.launch({
      args: [MAIN, ...SANDBOX_ARGS],
      env: launchEnv({ SIMPLEEDIT_REPO: repo.bareRepoPath })
    })
    window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await spawnClaudeSession(window)
    await openWorkspaceViewer(window)
  })

  test.afterEach(async () => {
    await app.close()
  })

  // NOTE: the old "Plan/Tour tabs inside DiffReview" tests were deleted in the
  // agent-first port. Plan and Tour are workspace TABS now (data-kind plan /
  // tour in the tab bar), not DiffReview panes — DiffReview's left pane only
  // toggles Files/Findings.

  test('diff review shows the Files / Findings toggle', async () => {
    await openFirstCommit(window)

    await expect(window.locator('button').filter({ hasText: /^Files/ }).first()).toBeVisible({ timeout: 5000 })
    await expect(window.locator('button').filter({ hasText: /^Findings/ }).first()).toBeVisible({ timeout: 5000 })
  })

  test('switching between a diff tab and the plan tab works', async () => {
    await openFirstCommit(window)
    const diffTabs = window.locator('[data-testid="worktree-tab"][data-kind="diff"]:visible')
    await expect(diffTabs.first()).toHaveAttribute('data-active', 'true', { timeout: 5000 })

    // Open the plan tab — it takes focus.
    await openPlanTab(window)
    await expect(planTabs(window).first()).toHaveAttribute('data-active', 'true', { timeout: 5000 })
    await expect(planTextarea(window)).toBeVisible({ timeout: 3000 })

    // Switch back to the diff tab — diff content renders again.
    await diffTabs.first().click()
    await expect(diffTabs.first()).toHaveAttribute('data-active', 'true')
    await expect(window.locator('button').filter({ hasText: /^Files/ }).first()).toBeVisible({ timeout: 5000 })
  })
})
