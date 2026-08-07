/**
 * E2E tests for the complete_task MCP flow (issue #53), ported to the
 * agent-first UI.
 *
 * We can't easily spawn a real Claude session in Playwright, so we simulate the
 * main-process side of the bridge by dispatching `tour:from-agent` IPC events
 * directly from the Electron main context, and assert the renderer's behaviour.
 *
 * Agent-first changes vs the original:
 *  - Tours are routed by SESSION: SessionWorkspace ignores tour:from-agent
 *    events whose terminalId is not its own session id, so each test spawns a
 *    Claude session first and sends with that id.
 *  - The notification toast is gone. Busy workspaces get a BACKGROUND tour tab
 *    with an unread marker instead; idle workspaces auto-focus the tour tab.
 */
import { test, expect } from '@playwright/test'
import { _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { MAIN, launchEnv, spawnClaudeSession, openWorkspaceViewer, clearSavedSessionFile, createTempRepo, removeTempRepo } from './fixtures'

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
      env: launchEnv({ SIMPLEEDIT_REPO: repo.bareRepoPath }),
    })
    window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    // Tours route per session — create the workspace that will receive them.
    sessionId = await spawnClaudeSession(window)
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

  async function sendTour(payload: Omit<TourPayload, 'worktreePath'> & { worktreePath?: string }): Promise<string> {
    const wt = payload.worktreePath ?? await getWorktreePath()
    await app.evaluate(({ BrowserWindow }, { wt: worktreePath, tid, p }) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win) return
      const key = `${worktreePath}:${p.commitHash ?? 'staging'}`
      win.webContents.send('tour:from-agent', {
        key,
        terminalId: tid,
        worktreePath,
        commitHash: p.commitHash,
        tour: p.tour,
      })
    }, { wt, tid: sessionId, p: { commitHash: payload.commitHash, tour: payload.tour } })
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

  const tourTabs = () => window.locator('[data-testid="worktree-tab"][data-kind="tour"]:visible')

  test('idle workspace: tour auto-opens directly into the Tour panel', async () => {
    // Fresh session → no tabs open → the tour should auto-focus its tab.
    await sendTour({ commitHash: null, tour: basicTour })

    await expect(tourTabs()).toHaveCount(1, { timeout: 5000 })
    await expect(tourTabs().first()).toHaveAttribute('data-active', 'true')
    // Auto-focused — not an unread background tab.
    await expect(tourTabs().first()).toHaveAttribute('data-unread', 'false')

    await expect(window.locator('h2:has-text("Overview"):visible')).toBeVisible({ timeout: 5000 })

    // Overview text from the Claude-delivered tour should be readable —
    // staging uses an editable textarea, commits use a paragraph.
    const overviewTextarea = window.locator('textarea[placeholder="Tour overview will appear here…"]:visible')
    await expect(overviewTextarea).toHaveValue(/Small refactor to the foo helper/, { timeout: 5000 })
  })

  test('busy workspace: tour arrives as a background tab with the unread marker', async () => {
    // Open a file so the workspace has an active tab (the old "toast" path —
    // toasts are gone; busy workspaces get a background tab + unread instead).
    await openWorkspaceViewer(window)
    const firstFile = window.locator('[role="treeitem"]:not([aria-expanded]):visible').first()
    await expect(firstFile).toBeVisible({ timeout: 5000 })
    await firstFile.click()
    const fileTabs = window.locator('[data-testid="worktree-tab"][data-kind="file"]:visible')
    await expect(fileTabs.first()).toHaveAttribute('data-active', 'true', { timeout: 5000 })

    await sendTour({ commitHash: null, tour: basicTour })

    await expect(tourTabs()).toHaveCount(1, { timeout: 5000 })
    // Background — the user's file tab keeps focus, the tour is flagged unread.
    await expect(tourTabs().first()).toHaveAttribute('data-active', 'false')
    await expect(tourTabs().first()).toHaveAttribute('data-unread', 'true')
    await expect(fileTabs.first()).toHaveAttribute('data-active', 'true')
  })

  test('open questions render as both attention banner and list', async () => {
    const tourWithQuestions: TourPayload['tour'] = {
      ...basicTour,
      openQuestions: ['Should we cache the result?', 'Is the fallback path still needed?'],
    }

    await sendTour({ commitHash: null, tour: tourWithQuestions })
    await window.waitForTimeout(1000)

    // Banner — picked up via its title text.
    await expect(window.locator(':text("Your input needed"):visible')).toBeVisible({ timeout: 5000 })

    // List below the tour — section heading visible.
    await expect(window.locator('h3:has-text("Open questions"):visible')).toBeVisible({ timeout: 3000 })

    // Each question renders as a list item.
    await expect(window.locator('li:visible:has-text("Should we cache the result?")')).toBeVisible({ timeout: 3000 })
    await expect(window.locator('li:visible:has-text("Is the fallback path still needed?")')).toBeVisible({ timeout: 3000 })
  })

  test('no banner when openQuestions is absent', async () => {
    await sendTour({ commitHash: null, tour: basicTour })
    // The tour itself must have opened — otherwise this assertion is vacuous.
    await expect(window.locator('h2:has-text("Overview"):visible')).toBeVisible({ timeout: 5000 })

    await expect(window.locator(':text("Your input needed"):visible')).not.toBeVisible()
    await expect(window.locator('h3:has-text("Open questions"):visible')).not.toBeVisible()
  })

  test('clicking the background tour tab opens the tour (old toast-View path)', async () => {
    // Make the workspace busy first so the tour lands in the background.
    await openWorkspaceViewer(window)
    const firstFile = window.locator('[role="treeitem"]:not([aria-expanded]):visible').first()
    await expect(firstFile).toBeVisible({ timeout: 5000 })
    await firstFile.click()
    await expect(
      window.locator('[data-testid="worktree-tab"][data-kind="file"]:visible').first()
    ).toHaveAttribute('data-active', 'true', { timeout: 5000 })

    await sendTour({
      commitHash: null,
      tour: { ...basicTour, openQuestions: ['Confirm approach?'] },
    })

    await expect(tourTabs()).toHaveCount(1, { timeout: 5000 })
    await tourTabs().first().click()

    // Tour tab renders overview + open-questions banner; unread clears.
    await expect(window.locator(':text("Your input needed"):visible')).toBeVisible({ timeout: 5000 })
    await expect(tourTabs().first()).toHaveAttribute('data-unread', 'false')
  })

  test('second tour for the same target updates in place without switching the tab', async () => {
    // Arrive: auto-opens on the Tour tab.
    await sendTour({ commitHash: null, tour: basicTour })
    await expect(window.locator('h2:has-text("Overview"):visible')).toBeVisible({ timeout: 5000 })
    await expect(tourTabs()).toHaveCount(1, { timeout: 5000 })

    // Send a second tour for the same staging target, with new open questions.
    // tabsStore reuses the tab identity — same single tab, updated content,
    // and since the user is already viewing it, focus must not change.
    await sendTour({
      commitHash: null,
      tour: { ...basicTour, openQuestions: ['Refined question?'] },
    })

    // Banner reflects the refined tour — proves the store got updated.
    await expect(window.locator(':text("Your input needed"):visible')).toBeVisible({ timeout: 5000 })
    await expect(window.locator('li:visible:has-text("Refined question?")')).toBeVisible({ timeout: 3000 })

    // Still exactly one tour tab, still active, no unread marker (we never left it).
    await expect(tourTabs()).toHaveCount(1)
    await expect(tourTabs().first()).toHaveAttribute('data-active', 'true')
    await expect(tourTabs().first()).toHaveAttribute('data-unread', 'false')
  })

  // NOTE: the old "toast Dismiss removes the notification without opening the
  // tour" test was deleted in the agent-first port. The notification toast no
  // longer exists — busy workspaces receive a background tab with an unread
  // marker (covered above) and there is nothing to dismiss.
})
