/**
 * Regression guards for two bugs introduced by the v0.12.0 save/restore feature
 * that surfaced as soon as the user opened a Claude tab:
 *
 *  1. `effect_update_depth_exceeded` — `publishClaudeTabs` (and friends) read
 *     their own state via `new Map(_state)` then assigned back, which inside an
 *     `$effect` is a tracked-read followed by a write to the same state. Fixed
 *     by wrapping the read in `untrack` in `sessionRestore.svelte.ts`.
 *  2. `DataCloneError` in `flushSessionSave` — the serialized session embedded
 *     `_visitedPrimaryPaths` / `_visitedSecondaryPaths` directly, which are
 *     Svelte 5 reactive proxy arrays that `structuredClone` (Electron IPC)
 *     refuses. Fixed by spreading them in `sessionPersistence.ts`.
 *
 * Lives in its own file because running it alongside the other Claude-spawning
 * tests in `ide.test.ts` causes Playwright/PTY interference unrelated to either
 * bug — the focused environment here is enough to catch the regression.
 */
import { test, expect } from '@playwright/test'
import { _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { MAIN } from './fixtures'
import { rmSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { createHash } from 'crypto'

const SANDBOX_ARGS = process.env.CI ? ['--no-sandbox'] : []
const repoPath = process.env.SIMPLEEDIT_TEST_REPO

function clearSavedSession(repo: string): void {
  // Playwright's unsigned Electron uses `Electron` as the userData app name.
  const hash = createHash('sha1').update(repo).digest('hex').slice(0, 16)
  const file = join(homedir(), 'Library', 'Application Support', 'Electron', 'config', 'sessions', `${hash}.json`)
  try { rmSync(file) } catch { /* not present */ }
}

test.describe('session save/restore — Claude tab does not loop or break IPC', () => {
  test.skip(!repoPath, 'Set SIMPLEEDIT_TEST_REPO to run')

  let app: ElectronApplication
  let window: Page
  let pageErrors: string[] = []

  test.beforeEach(async () => {
    pageErrors = []
    // Start every test with a fresh session — the visited-paths and tabs that
    // accumulate across runs would otherwise produce multiple panes/tab bars
    // and break the strict-mode locators below.
    clearSavedSession(repoPath!)
    app = await electron.launch({
      args: [MAIN, ...SANDBOX_ARGS],
      env: { ...process.env, SIMPLEEDIT_REPO: repoPath! }
    })
    window = await app.firstWindow()
    window.on('pageerror', (err) => { pageErrors.push(`${err.name}: ${err.message}`) })
    window.on('console', (m) => { if (m.type() === 'error') pageErrors.push(`[console] ${m.text()}`) })
    await window.waitForLoadState('domcontentloaded')
    await expect(window.getByRole('listbox', { name: 'Commits' })).toBeVisible({ timeout: 5000 })
  })

  test.afterEach(async () => {
    await app.close()
  })

  test('opening a Claude tab does not throw or freeze the UI', async () => {
    const commits = window.getByRole('listbox', { name: 'Commits' }).getByRole('option')
    if ((await commits.count()) < 2) test.skip()

    // Baseline: peek-open a diff via single-click on a commit
    await commits.nth(0).click()
    const tabBar = window.getByTestId('worktree-tab-bar')
    await expect(tabBar).toBeVisible({ timeout: 3000 })
    expect(await tabBar.locator('[data-testid="worktree-tab"][data-kind="diff"]').count()).toBe(1)

    // The repro trigger — both errors used to fire on this click before the
    // user could do anything else.
    await window.getByTitle('Run Claude Code').first().click()
    await window.waitForTimeout(1500)

    // Subsequent clicks must still drive the tab bar (peek-replace, not stack)
    await commits.nth(1).click()
    await window.waitForTimeout(300)
    expect(
      await tabBar.locator('[data-testid="worktree-tab"][data-kind="diff"]').count(),
      'peek-replace must still work after opening a Claude tab',
    ).toBe(1)

    // Neither effect_update_depth_exceeded nor DataCloneError may have fired
    expect(pageErrors).toEqual([])
  })

  test('switching worktrees still works after opening a Claude tab', async () => {
    const worktrees = window.getByRole('listbox', { name: 'Worktrees' }).getByRole('option')
    if ((await worktrees.count()) < 2) test.skip()

    await window.getByTitle('Run Claude Code').first().click()
    await window.waitForTimeout(1500)

    const second = worktrees.nth(1)
    await second.click()
    await expect(second).toHaveAttribute('aria-selected', 'true', { timeout: 3000 })

    expect(pageErrors).toEqual([])
  })
})
