import { test, expect } from '@playwright/test'
import { _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import {
  MAIN,
  launchEnv,
  spawnTerminalSession,
  clearSavedSessionFile,
  createTempRepo,
  removeTempRepo,
  openWorktreePopover,
  headerWorktreeBranch
} from './fixtures'

const SANDBOX_ARGS = process.env.CI ? ['--no-sandbox'] : []
const repoPath = process.env.SIMPLEEDIT_TEST_REPO

/**
 * Ported twice: sessions are the primary entity, and as of f1e6062 the sidebar
 * is sessions-only — worktree management (the same WorktreeList) lives in a
 * role="dialog" popover behind the workspace header's branch button. Selecting
 * or creating a worktree closes the popover and repoints the active session,
 * so list assertions after a selection reopen the popover first.
 */
test.describe('Switch active worktree', () => {
  test.skip(!repoPath, 'Set SIMPLEEDIT_TEST_REPO to run worktree-switch tests')

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
  })

  test.afterEach(async () => {
    await app.close()
  })

  test('the sidebar contains no worktree list — sessions only', async () => {
    await spawnTerminalSession(window)
    const sidebar = window.getByRole('complementary')
    await expect(sidebar.getByRole('listbox', { name: 'Sessions' })).toBeVisible()
    await expect(sidebar.getByRole('listbox', { name: 'Worktrees' })).toHaveCount(0)
  })

  test('the worktree popover lists at least one worktree entry', async () => {
    await spawnTerminalSession(window)
    const dialog = await openWorktreePopover(window)
    const options = dialog.getByRole('listbox', { name: 'Worktrees' }).getByRole('option')
    await expect(options.first()).toBeVisible()
  })

  test('a new session points at the first (main) worktree, selecting it', async () => {
    // There is no selection until a session exists. New sessions launch in
    // worktreeList()[0], so spawning one selects the first worktree entry.
    await spawnTerminalSession(window)

    const dialog = await openWorktreePopover(window)
    const firstOption = dialog
      .getByRole('listbox', { name: 'Worktrees' })
      .getByRole('option')
      .first()
    await expect(firstOption).toHaveAttribute('aria-selected', 'true')
  })

  test("the session's worktree branch is shown on the workspace header button", async () => {
    await spawnTerminalSession(window)

    const dialog = await openWorktreePopover(window)
    const firstOption = dialog
      .getByRole('listbox', { name: 'Worktrees' })
      .getByRole('option')
      .first()
    await expect(firstOption).toHaveAttribute('aria-selected', 'true')

    // The branch name text inside the option (the <span class="flex-1 truncate"> child)
    const branchName = await firstOption.locator('span.flex-1').textContent()
    expect(branchName).toBeTruthy()

    // Close the popover (Esc) and read the header button label.
    await window.keyboard.press('Escape')
    await expect(dialog).not.toBeVisible()
    await expect
      .poll(async () => await headerWorktreeBranch(window), { timeout: 5_000 })
      .toBe(branchName!.trim())
  })

  test('clicking a different worktree repoints the active session and closes the popover', async () => {
    await spawnTerminalSession(window)

    let dialog = await openWorktreePopover(window)
    const options = dialog.getByRole('listbox', { name: 'Worktrees' }).getByRole('option')
    const count = await options.count()

    if (count < 2) {
      test.skip() // only one worktree — switching is not possible
      return
    }

    // Capture the branch name of the second worktree
    const secondOption = options.nth(1)
    const secondBranch = await secondOption.locator('span.flex-1').textContent()
    expect(secondBranch).toBeTruthy()

    // Click the second worktree — repoints the session and closes the popover.
    await secondOption.click()
    await expect(dialog).not.toBeVisible()

    // Header button reflects the newly-pointed branch.
    await expect
      .poll(async () => await headerWorktreeBranch(window), { timeout: 5_000 })
      .toBe(secondBranch!.trim())

    // Reopen — the second entry is selected, the first no longer is.
    dialog = await openWorktreePopover(window)
    const reopened = dialog.getByRole('listbox', { name: 'Worktrees' }).getByRole('option')
    await expect(reopened.nth(1)).toHaveAttribute('aria-selected', 'true')
    await expect(reopened.first()).toHaveAttribute('aria-selected', 'false')
  })

  test('clicking the already-active worktree keeps it selected', async () => {
    await spawnTerminalSession(window)

    let dialog = await openWorktreePopover(window)
    const firstOption = dialog
      .getByRole('listbox', { name: 'Worktrees' })
      .getByRole('option')
      .first()

    // Ensure it is active first (the new session points at it)
    await expect(firstOption).toHaveAttribute('aria-selected', 'true')

    // Click it again — popover closes; reopened state is unchanged.
    await firstOption.click()
    await expect(dialog).not.toBeVisible()

    dialog = await openWorktreePopover(window)
    await expect(
      dialog.getByRole('listbox', { name: 'Worktrees' }).getByRole('option').first()
    ).toHaveAttribute('aria-selected', 'true')
  })

  test('worktree can be activated with keyboard (Enter / Space)', async () => {
    await spawnTerminalSession(window)

    const dialog = await openWorktreePopover(window)
    const options = dialog.getByRole('listbox', { name: 'Worktrees' }).getByRole('option')
    const count = await options.count()

    if (count < 2) {
      test.skip()
      return
    }

    const secondOption = options.nth(1)
    const secondBranch = await secondOption.locator('span.flex-1').textContent()

    // Focus the second option and press Enter — selects and closes the popover.
    await secondOption.focus()
    await secondOption.press('Enter')
    await expect(dialog).not.toBeVisible()

    await expect
      .poll(async () => await headerWorktreeBranch(window), { timeout: 5_000 })
      .toBe(secondBranch!.trim())
  })

  test('switching back to the first worktree restores the header label', async () => {
    await spawnTerminalSession(window)

    let dialog = await openWorktreePopover(window)
    const options = dialog.getByRole('listbox', { name: 'Worktrees' }).getByRole('option')
    const count = await options.count()

    if (count < 2) {
      test.skip()
      return
    }

    const firstBranch = await options.first().locator('span.flex-1').textContent()

    // Switch to second worktree (closes popover), then back to first.
    await options.nth(1).click()
    await expect(dialog).not.toBeVisible()

    dialog = await openWorktreePopover(window)
    await dialog
      .getByRole('listbox', { name: 'Worktrees' })
      .getByRole('option')
      .first()
      .click()
    await expect(dialog).not.toBeVisible()

    // Header button reflects the first branch again.
    await expect
      .poll(async () => await headerWorktreeBranch(window), { timeout: 5_000 })
      .toBe(firstBranch!.trim())
  })
})
