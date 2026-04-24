/**
 * E2E tests for the complete_task MCP flow (issue #53).
 *
 * We can't easily spawn a real Claude session in Playwright, so we simulate the
 * main-process side of the bridge by dispatching `tour:from-claude` IPC events
 * directly from the Electron main context, and assert the renderer's behaviour.
 */
import { test, expect } from '@playwright/test'
import { _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { MAIN } from './fixtures'

const SANDBOX_ARGS = process.env.CI ? ['--no-sandbox'] : []
const repoPath = process.env.SIMPLEEDIT_TEST_REPO

interface TourPayload {
  worktreePath: string
  commitHash: string | null
  tour: {
    overview: string
    topics: Array<{
      title: string
      summary: string
      segments: Array<{ prose: string; file: string; lineRange: [number, number] }>
    }>
    openQuestions?: string[]
  }
}

test.describe('complete_task — tour-from-Claude', () => {
  test.skip(!repoPath, 'Set SIMPLEEDIT_TEST_REPO to run complete_task tests')

  let app: ElectronApplication
  let window: Page

  test.beforeEach(async () => {
    app = await electron.launch({
      args: [MAIN, ...SANDBOX_ARGS],
      env: { ...process.env, SIMPLEEDIT_REPO: repoPath! },
    })
    window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await window.waitForTimeout(2000)
  })

  test.afterEach(async () => {
    await app.close()
  })

  async function getWorktreePath(): Promise<string> {
    return window.evaluate(() =>
      (window as unknown as { api: { invoke: (ch: string) => Promise<Array<{ path: string }>> } })
        .api.invoke('worktree:list').then((list) => list[0]?.path ?? '')
    )
  }

  async function sendTour(payload: Omit<TourPayload, 'worktreePath'> & { worktreePath?: string }, terminalId = 'tour-test'): Promise<string> {
    const wt = payload.worktreePath ?? await getWorktreePath()
    await app.evaluate(({ BrowserWindow }, { wt: worktreePath, tid, p }) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win) return
      const key = `${worktreePath}:${p.commitHash ?? 'staging'}`
      win.webContents.send('tour:from-claude', {
        key,
        terminalId: tid,
        worktreePath,
        commitHash: p.commitHash,
        tour: p.tour,
      })
    }, { wt, tid: terminalId, p: { commitHash: payload.commitHash, tour: payload.tour } })
    return wt
  }

  const basicTour: TourPayload['tour'] = {
    overview: 'Small refactor to the foo helper.',
    topics: [
      {
        title: 'Extract shared helper',
        summary: 'Moved duplicated logic into a single function',
        segments: [
          { prose: 'The new helper consolidates three call sites.', file: 'README.md', lineRange: [1, 3] },
        ],
      },
    ],
  }

  test('empty pane: tour auto-opens directly into the Tour panel', async () => {
    // Fresh launch → pane is empty, so the tour should auto-open on the Tour tab.
    await sendTour({ commitHash: null, tour: basicTour })

    // The Tour panel's "Overview" heading is only rendered when the Tour tab is active.
    // When activeTab === 'tour', DiffReview hides the tab bar and renders TourPanel full-width.
    await expect(window.locator('h2:has-text("Overview")')).toBeVisible({ timeout: 5000 })

    // Overview text from the Claude-delivered tour should be readable —
    // staging uses an editable textarea, commits use a paragraph.
    const overviewTextarea = window.locator('textarea[placeholder="Tour overview will appear here…"]')
    await expect(overviewTextarea).toHaveValue(/Small refactor to the foo helper/, { timeout: 5000 })

    // No notification toast should be visible — we opened directly.
    await expect(window.locator('text=Claude finished a task')).not.toBeVisible()
  })

  test('notification toast appears when the pane is not empty', async () => {
    // Open a file so the pane is no longer empty.
    const firstFile = window.locator('[role="treeitem"]').first()
    await expect(firstFile).toBeVisible({ timeout: 5000 })
    await firstFile.click()
    await window.waitForTimeout(500)

    await sendTour({ commitHash: null, tour: basicTour })
    await window.waitForTimeout(1000)

    const toast = window.locator('text=Claude finished a task')
    await expect(toast).toBeVisible({ timeout: 5000 })

    // The "View tour" button should be present on the toast.
    const viewBtn = window.locator('button:has-text("View tour")')
    await expect(viewBtn).toBeVisible({ timeout: 3000 })
  })

  test('open questions render as both attention banner and list', async () => {
    const tourWithQuestions: TourPayload['tour'] = {
      ...basicTour,
      openQuestions: ['Should we cache the result?', 'Is the fallback path still needed?'],
    }

    await sendTour({ commitHash: null, tour: tourWithQuestions })
    await window.waitForTimeout(1000)

    // Banner — picked up via its title text.
    await expect(window.locator('text=Your input needed')).toBeVisible({ timeout: 5000 })

    // List below the tour — section heading visible.
    await expect(window.locator('h3:has-text("Open questions")')).toBeVisible({ timeout: 3000 })

    // Each question renders as a list item.
    await expect(window.locator('li:has-text("Should we cache the result?")')).toBeVisible({ timeout: 3000 })
    await expect(window.locator('li:has-text("Is the fallback path still needed?")')).toBeVisible({ timeout: 3000 })
  })

  test('no banner when openQuestions is absent', async () => {
    await sendTour({ commitHash: null, tour: basicTour })
    await window.waitForTimeout(1000)

    await expect(window.locator('text=Your input needed')).not.toBeVisible()
    await expect(window.locator('h3:has-text("Open questions")')).not.toBeVisible()
  })

  test('toast View button opens the tour on the Tour tab', async () => {
    // Make the pane non-empty first so we get the toast path.
    const firstFile = window.locator('[role="treeitem"]').first()
    await expect(firstFile).toBeVisible({ timeout: 5000 })
    await firstFile.click()
    await window.waitForTimeout(500)

    await sendTour({
      commitHash: null,
      tour: { ...basicTour, openQuestions: ['Confirm approach?'] },
    })
    await window.waitForTimeout(1000)

    await window.locator('button:has-text("View tour")').click()
    await window.waitForTimeout(500)

    // Tour tab renders overview + open-questions banner.
    await expect(window.locator('text=Your input needed')).toBeVisible({ timeout: 5000 })
  })

  test('second tour for the same target updates in place without switching the tab', async () => {
    // Arrive: auto-opens on Tour tab.
    await sendTour({ commitHash: null, tour: basicTour })
    await expect(window.locator('h2:has-text("Overview")')).toBeVisible({ timeout: 5000 })

    // Navigate off the Tour tab manually — back to Files list (user reviewing the diff).
    // The tab bar is only present in non-tour modes, so get there via staging bar first.
    // Simplest repro: click the "Uncommitted changes" entry in the sidebar after closing the tour.
    // Here we just verify the "in-place" invariant holds: sending a second tour must NOT
    // force a tab switch away from what the user is on. We verify this indirectly by
    // checking the banner updates to a new tour's openQuestions while the Tour panel remains active.

    // Send a second tour for the same staging target, with new open questions.
    await sendTour({
      commitHash: null,
      tour: { ...basicTour, openQuestions: ['Refined question?'] },
    })

    // Banner reflects the refined tour — proves the store got updated.
    await expect(window.locator('text=Your input needed')).toBeVisible({ timeout: 5000 })
    await expect(window.locator('li:has-text("Refined question?")')).toBeVisible({ timeout: 3000 })

    // Still no toast — we were already viewing the target, so no notification should appear.
    await expect(window.locator('text=Claude finished a task')).not.toBeVisible()
  })

  test('toast Dismiss removes the notification without opening the tour', async () => {
    const firstFile = window.locator('[role="treeitem"]').first()
    await expect(firstFile).toBeVisible({ timeout: 5000 })
    await firstFile.click()
    await window.waitForTimeout(500)

    await sendTour({ commitHash: null, tour: basicTour })
    await window.waitForTimeout(1000)

    await expect(window.locator('text=Claude finished a task')).toBeVisible({ timeout: 5000 })
    await window.locator('div:has(> span:has-text("Claude finished a task")) button:has-text("Dismiss")').click()
    await window.waitForTimeout(500)

    await expect(window.locator('text=Claude finished a task')).not.toBeVisible()

    // Pane did not switch: no Tour tab visible (editor still active).
    await expect(window.locator('button').filter({ hasText: /^Tour/ })).not.toBeVisible()
  })
})
