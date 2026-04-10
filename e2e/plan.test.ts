/**
 * E2E tests for Plan Mode feature.
 */
import { test, expect } from '@playwright/test'
import { _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { MAIN } from './fixtures'

const SANDBOX_ARGS = process.env.CI ? ['--no-sandbox'] : []
const repoPath = process.env.SIMPLEEDIT_TEST_REPO

/** Click the first commit in the git log sidebar and wait for diff review. */
async function openFirstCommit(window: Page): Promise<void> {
  const commitList = window.locator('[role="listbox"][aria-label="Commits"]')
  await expect(commitList).toBeVisible({ timeout: 10000 })
  const firstCommit = commitList.locator('[role="option"]').first()
  await expect(firstCommit).toBeVisible({ timeout: 5000 })
  await firstCommit.click()
  await window.waitForTimeout(1500)
}

/** Open PlanView via sidebar button. */
async function openPlanView(window: Page): Promise<void> {
  const planBtn = window.locator('aside button:has-text("Plan")').first()
  await planBtn.click()
  await window.waitForTimeout(500)
}

test.describe('Plan Mode — Sidebar entry point', () => {
  test.skip(!repoPath, 'Set SIMPLEEDIT_TEST_REPO to run Plan Mode tests')

  let app: ElectronApplication
  let window: Page

  test.beforeEach(async () => {
    app = await electron.launch({
      args: [MAIN, ...SANDBOX_ARGS],
      env: { ...process.env, SIMPLEEDIT_REPO: repoPath! }
    })
    window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await window.waitForTimeout(2000)
  })

  test.afterEach(async () => {
    await app.close()
  })

  test('Plan button appears in Git Log sidebar', async () => {
    const planBtn = window.locator('aside button:has-text("Plan")')
    await expect(planBtn.first()).toBeVisible({ timeout: 5000 })
  })

  test('clicking Plan button opens PlanView with text input', async () => {
    await openPlanView(window)

    // PlanView should show the description textarea (from PlanView header)
    const textarea = window.locator('textarea').first()
    await expect(textarea).toBeVisible({ timeout: 5000 })
  })

  test('PlanView has a Back button that closes it', async () => {
    await openPlanView(window)

    const backBtn = window.locator('button:has-text("← Back")')
    await expect(backBtn).toBeVisible({ timeout: 3000 })
    await backBtn.click()
    await window.waitForTimeout(500)

    // PlanView description input should no longer be visible
    const planViewTextarea = window.locator('textarea[placeholder*="Add user authentication"]')
    await expect(planViewTextarea).not.toBeVisible({ timeout: 2000 })
  })

  test('Generate Plan button is disabled until text is entered', async () => {
    await openPlanView(window)

    const generateBtn = window.locator('button:has-text("Generate Plan")')
    await expect(generateBtn.first()).toBeVisible({ timeout: 3000 })
    await expect(generateBtn.first()).toBeDisabled()

    // Type something
    const textarea = window.locator('textarea').first()
    await textarea.fill('Add a new feature')
    await window.waitForTimeout(200)

    await expect(generateBtn.first()).toBeEnabled()
  })

  test('PlanView shows description textarea', async () => {
    await openPlanView(window)
    const textarea = window.locator('textarea').first()
    await expect(textarea).toBeVisible({ timeout: 3000 })
  })
})

test.describe('Plan Mode — Lifecycle', () => {
  test.skip(!repoPath, 'Set SIMPLEEDIT_TEST_REPO to run Plan Mode tests')

  let app: ElectronApplication
  let window: Page

  test.beforeEach(async () => {
    app = await electron.launch({
      args: [MAIN, ...SANDBOX_ARGS],
      env: { ...process.env, SIMPLEEDIT_REPO: repoPath! }
    })
    window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await window.waitForTimeout(2000)
  })

  test.afterEach(async () => {
    await app.close()
  })

  test('Plan reopens after Back and clicking Plan again', async () => {
    // Open plan
    await openPlanView(window)
    const textarea = window.locator('textarea').first()
    await expect(textarea).toBeVisible({ timeout: 3000 })

    // Go back
    const backBtn = window.locator('button:has-text("← Back")')
    await backBtn.click()
    await window.waitForTimeout(500)

    // Open plan again
    await openPlanView(window)

    // Should show the plan view again
    const textarea2 = window.locator('textarea').first()
    await expect(textarea2).toBeVisible({ timeout: 3000 })
  })

  test('Plan reopens after navigating to a commit and back', async () => {
    // Open plan first
    await openPlanView(window)
    const textarea = window.locator('textarea').first()
    await expect(textarea).toBeVisible({ timeout: 3000 })

    // Navigate to a commit (replaces PlanView with DiffReview)
    await openFirstCommit(window)

    // Now open plan again
    await openPlanView(window)

    // Should show plan view
    const textarea2 = window.locator('textarea').first()
    await expect(textarea2).toBeVisible({ timeout: 3000 })
  })

  test('multiple rapid Plan button clicks do not break the view', async () => {
    const planBtn = window.locator('aside button:has-text("Plan")').first()

    // Click rapidly
    await planBtn.click()
    await planBtn.click()
    await planBtn.click()
    await window.waitForTimeout(500)

    // Should still show plan view properly
    const textarea = window.locator('textarea').first()
    await expect(textarea).toBeVisible({ timeout: 3000 })
  })
})

test.describe('Plan Mode — Claude-originated plan', () => {
  test.skip(!repoPath, 'Set SIMPLEEDIT_TEST_REPO to run Plan Mode tests')

  let app: ElectronApplication
  let window: Page

  test.beforeEach(async () => {
    app = await electron.launch({
      args: [MAIN, ...SANDBOX_ARGS],
      env: { ...process.env, SIMPLEEDIT_REPO: repoPath! }
    })
    window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await window.waitForTimeout(2000)
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

  /** Send a plan:from-claude IPC event using the correct worktree path. */
  async function sendPlan(terminalId: string, overview: string): Promise<void> {
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
      { wt, tid: terminalId, overview }
    )
  }

  test('plan notification toast appears when Claude sends a plan via bridge', async () => {
    await sendPlan('test-terminal', 'E2E Test Plan')
    await window.waitForTimeout(1000)

    const toast = window.locator('text=Claude generated a plan')
    await expect(toast).toBeVisible({ timeout: 5000 })
  })

  test('clicking View on toast opens PlanView', async () => {
    await sendPlan('view-term', 'Viewable Plan')
    await window.waitForTimeout(1000)

    const toastContainer = window.locator('div:has(> span:text("Claude generated a plan"))')
    const viewBtn = toastContainer.locator('button:has-text("View")')
    await expect(viewBtn).toBeVisible({ timeout: 5000 })
    await viewBtn.click()
    await window.waitForTimeout(500)

    const indicator = window.locator('span:text-is("✦ From Claude session")')
    await expect(indicator).toBeVisible({ timeout: 5000 })
  })

  test('Send to Claude button appears for Claude-originated plans', async () => {
    await sendPlan('feedback-term', 'Feedback Plan')
    await window.waitForTimeout(1000)

    const toastContainer = window.locator('div:has(> span:text("Claude generated a plan"))')
    const viewBtn = toastContainer.locator('button:has-text("View")')
    await expect(viewBtn).toBeVisible({ timeout: 5000 })
    await viewBtn.click()
    await window.waitForTimeout(500)

    const sendBtn = window.locator('button:has-text("Send to Claude")')
    await expect(sendBtn).toBeVisible({ timeout: 5000 })
  })

  test('PlanView shows user-plan textarea when not from Claude', async () => {
    await openPlanView(window)
    await window.waitForTimeout(500)

    const textarea = window.locator('textarea').first()
    await expect(textarea).toBeVisible({ timeout: 3000 })
  })
})

test.describe('Plan Mode — DiffReview tab', () => {
  test.skip(!repoPath, 'Set SIMPLEEDIT_TEST_REPO to run Plan Mode tests')

  let app: ElectronApplication
  let window: Page

  test.beforeEach(async () => {
    app = await electron.launch({
      args: [MAIN, ...SANDBOX_ARGS],
      env: { ...process.env, SIMPLEEDIT_REPO: repoPath! }
    })
    window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await window.waitForTimeout(2000)
  })

  test.afterEach(async () => {
    await app.close()
  })

  test('Plan tab exists in diff review alongside Files, Findings, Tour', async () => {
    await openFirstCommit(window)

    await expect(window.locator('button').filter({ hasText: /^Files/ }).first()).toBeVisible({ timeout: 5000 })
    await expect(window.locator('button').filter({ hasText: /^Findings/ }).first()).toBeVisible({ timeout: 5000 })
    await expect(window.locator('button').filter({ hasText: /^Tour/ }).first()).toBeVisible({ timeout: 5000 })
    await expect(window.locator('button').filter({ hasText: /^Plan/ }).first()).toBeVisible({ timeout: 5000 })
  })

  test('Plan tab in diff review shows text input for plan description', async () => {
    await openFirstCommit(window)

    const planTab = window.locator('button').filter({ hasText: /^Plan/ }).last()
    await planTab.click()
    await window.waitForTimeout(500)

    const textarea = window.locator('textarea[placeholder*="Describe what you want"]')
    const generateBtn = window.locator('button:has-text("Generate Plan")')
    await expect(textarea.or(generateBtn).first()).toBeVisible({ timeout: 5000 })
  })

  test('switching between Files and Plan tabs works', async () => {
    await openFirstCommit(window)

    // Switch to Plan tab
    const planTab = window.locator('button').filter({ hasText: /^Plan/ }).last()
    await planTab.click()
    await window.waitForTimeout(500)

    // Verify plan content visible
    const textarea = window.locator('textarea[placeholder*="Describe what you want"]')
    await expect(textarea).toBeVisible({ timeout: 3000 })

    // Switch back to Files tab (the tab bar is hidden in plan view,
    // but we can click Back to go to files)
    // Actually in DiffReview, Plan is full-width so we'd need to
    // use the sidebar to navigate. Let's verify switching via commit click.
    await openFirstCommit(window)
    await window.waitForTimeout(500)

    // Should show file list (back in files tab)
    const diffPrompt = window.locator('text=Select a file to view its diff')
    const fileBtn = window.locator('button[title]').first()
    await expect(diffPrompt.or(fileBtn).first()).toBeVisible({ timeout: 5000 })
  })
})
