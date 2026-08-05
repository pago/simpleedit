/**
 * Regression guards for two bugs introduced by the v0.12.0 save/restore feature
 * that surfaced as soon as the user opened a Claude tab:
 *
 *  1. `effect_update_depth_exceeded` — a serializer effect that read its own
 *     state then wrote it back inside an `$effect`.
 *  2. `DataCloneError` in `flushSessionSave` — Svelte 5 reactive proxies were
 *     embedded directly in the serialized blob; `structuredClone` (Electron
 *     IPC) refuses them.
 *
 * Ported to the agent-first UI: "opening a Claude tab" is now "creating a
 * Claude session", which triggers the same debounced session-save path. The
 * guard remains "no renderer errors fire and the tab model keeps working".
 *
 * Lives in its own file because running it alongside the other Claude-spawning
 * tests in `ide.test.ts` causes Playwright/PTY interference unrelated to either
 * bug — the focused environment here is enough to catch the regression.
 */
import { test, expect } from '@playwright/test'
import { _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import {
  MAIN,
  launchEnv,
  spawnClaudeSession,
  openWorkspaceViewer,
  createTempRepo,
  removeTempRepo,
  clearSavedSessionFile,
  openWorktreePopover
} from './fixtures'
const SANDBOX_ARGS = process.env.CI ? ['--no-sandbox'] : []
const repoPath = process.env.SIMPLEEDIT_TEST_REPO

test.describe('session save/restore — Claude session does not loop or break IPC', () => {
  test.skip(!repoPath, 'Set SIMPLEEDIT_TEST_REPO to run')

  let app: ElectronApplication
  let window: Page
  let pageErrors: string[] = []

  let repo: ReturnType<typeof createTempRepo>
  test.beforeAll(() => {
    repo = createTempRepo('simpleedit-e2e-')
  })
  test.afterAll(() => {
    removeTempRepo(repo)
  })

  test.beforeEach(async () => {
    pageErrors = []
    // Start every test with a fresh session — restored placeholders from an
    // earlier run would otherwise pollute the Sessions list.
    clearSavedSessionFile(repo.bareRepoPath)
    app = await electron.launch({
      args: [MAIN, ...SANDBOX_ARGS],
      env: launchEnv({ SIMPLEEDIT_REPO: repo.bareRepoPath })
    })
    window = await app.firstWindow()
    window.on('pageerror', (err) => { pageErrors.push(`${err.name}: ${err.message}`) })
    window.on('console', (m) => { if (m.type() === 'error') pageErrors.push(`[console] ${m.text()}`) })
    await window.waitForLoadState('domcontentloaded')
    // GitLog lives in the per-session workspace now — create one and open it.
    await spawnClaudeSession(window)
    await openWorkspaceViewer(window)
  })

  test.afterEach(async () => {
    await app.close()
  })

  /** Session entries in the sidebar Sessions listbox, in display order. */
  function sessionOptions() {
    return window.getByRole('listbox', { name: 'Sessions' }).getByRole('option')
  }

  test('creating a Claude session does not throw or freeze the UI', async () => {
    const commits = window.getByRole('listbox', { name: 'Commits' }).getByRole('option')
    if ((await commits.count()) < 2) test.skip()

    // Baseline: peek-open a diff via single-click on a commit
    await commits.first().click()
    const tabBar = window.getByTestId('worktree-tab-bar')
    await expect(tabBar).toBeVisible({ timeout: 3000 })
    expect(await tabBar.locator('[data-testid="worktree-tab"][data-kind="diff"]').count()).toBe(1)

    // The repro trigger — creating another Claude session kicks off the
    // debounced session save (both old errors fired on this path). The new
    // session takes focus; switch back to the first workspace afterwards.
    await window.getByRole('button', { name: 'New agent session' }).first().click()
    await window.waitForTimeout(1500)
    await sessionOptions().nth(1).click() // claude sessions prepend — original is now second
    await window.waitForTimeout(300)

    // Subsequent clicks must still drive the tab bar (peek-replace, not stack)
    await commits.nth(1).click()
    await window.waitForTimeout(300)
    expect(
      await tabBar.locator('[data-testid="worktree-tab"][data-kind="diff"]').count(),
      'peek-replace must still work after opening a Claude session',
    ).toBe(1)

    // Neither effect_update_depth_exceeded nor DataCloneError may have fired
    expect(pageErrors).toEqual([])
  })

  test('switching worktrees still works after opening a Claude session', async () => {
    // A second Claude session — the worktree selection below repoints it.
    await window.getByRole('button', { name: 'New agent session' }).first().click()
    await window.waitForTimeout(1500)

    // Worktrees live in the workspace header popover (f1e6062).
    let dialog = await openWorktreePopover(window)
    const worktrees = dialog.getByRole('listbox', { name: 'Worktrees' }).getByRole('option')
    if ((await worktrees.count()) < 2) test.skip()

    // Selecting closes the popover; reopen to verify the selection.
    await worktrees.nth(1).click()
    await expect(dialog).not.toBeVisible()
    dialog = await openWorktreePopover(window)
    await expect(
      dialog.getByRole('listbox', { name: 'Worktrees' }).getByRole('option').nth(1)
    ).toHaveAttribute('aria-selected', 'true', { timeout: 3000 })

    expect(pageErrors).toEqual([])
  })
})
