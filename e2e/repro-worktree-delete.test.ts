import { test, expect } from '@playwright/test'
import { _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page, Locator } from '@playwright/test'
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

// ── suite ─────────────────────────────────────────────────────────────────────

/**
 * As of f1e6062 the WorktreeList (and its two-step remove flow) lives in the
 * workspace header's worktree popover. Creating a worktree closes the popover
 * (and repoints the active session); removing does not.
 */
test.describe('Delete worktree', () => {
  test.skip(!repoPath, 'Set SIMPLEEDIT_TEST_REPO to run worktree-delete tests')

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
    // The worktree popover lives in a workspace header — a session must exist.
    await spawnTerminalSession(window)
  })

  test.afterEach(async () => {
    await app.close()
  })

  // ── helpers ────────────────────────────────────────────────────────────────

  function worktreeOption(dialog: Locator, branchName: string): Locator {
    return dialog
      .getByRole('listbox', { name: 'Worktrees' })
      .getByRole('option', { name: new RegExp(branchName) })
  }

  /**
   * Create a worktree via the popover's "+ New" flow. Creating closes the
   * popover, so reopen it and wait for the new row. Returns the open dialog.
   */
  async function createWorktree(branchName: string): Promise<Locator> {
    let dialog = await openWorktreePopover(window)
    await dialog.getByRole('button', { name: '+ New' }).click()
    const nameInput = dialog.getByPlaceholder('branch-name')
    await expect(nameInput).toBeVisible()
    await nameInput.fill(branchName)
    await dialog.getByRole('button', { name: 'Create' }).click()
    await expect(dialog).not.toBeVisible({ timeout: 10_000 })

    dialog = await openWorktreePopover(window)
    await expect(worktreeOption(dialog, branchName)).toBeVisible({ timeout: 10_000 })
    return dialog
  }

  async function waitForWorktreeGone(dialog: Locator, branchName: string): Promise<void> {
    await expect(worktreeOption(dialog, branchName)).not.toBeVisible({ timeout: 10_000 })
  }

  // ── happy path ─────────────────────────────────────────────────────────────

  test('creates a worktree, deletes it via confirmation, verifies it is gone', async () => {
    const branchName = `test-delete-${Date.now()}`

    const dialog = await createWorktree(branchName)

    // --- DELETE (two-step confirmation) ---
    const worktreeItem = worktreeOption(dialog, branchName)

    // The "Remove" button is only visible on hover (opacity-0 → group-hover:opacity-100)
    await worktreeItem.hover()
    const removeBtn = worktreeItem.getByRole('button', { name: 'Remove' })
    await expect(removeBtn).toBeVisible()
    await removeBtn.click()

    // Confirmation buttons should now be visible
    const confirmBtn = worktreeItem.getByRole('button', { name: 'Confirm' })
    const cancelBtn = worktreeItem.getByRole('button', { name: 'Cancel' })
    await expect(confirmBtn).toBeVisible()
    await expect(cancelBtn).toBeVisible()

    await confirmBtn.click()

    // Worktree must disappear from the list (removal keeps the popover open)
    await waitForWorktreeGone(dialog, branchName)
  })

  // ── cancel confirmation ────────────────────────────────────────────────────

  test('cancel during confirmation leaves worktree intact', async () => {
    const branchName = `test-nodelete-${Date.now()}`

    const dialog = await createWorktree(branchName)

    // Initiate delete
    const worktreeItem = worktreeOption(dialog, branchName)
    await worktreeItem.hover()
    await worktreeItem.getByRole('button', { name: 'Remove' }).click()

    // Cancel
    await worktreeItem.getByRole('button', { name: 'Cancel' }).click()

    // "Remove" button should be back (confirmation dismissed), worktree still present
    await expect(worktreeOption(dialog, branchName)).toBeVisible()

    // Clean up: actually delete the worktree so the repo is left clean
    await worktreeItem.hover()
    await worktreeItem.getByRole('button', { name: 'Remove' }).click()
    await worktreeItem.getByRole('button', { name: 'Confirm' }).click()
    await waitForWorktreeGone(dialog, branchName)
  })

  // ── delete active worktree ────────────────────────────────────────────────

  test('deleting the worktree the active session points at keeps the app usable', async () => {
    // There is no auto-switch to another worktree. Deleting the worktree an
    // active session points at leaves the session alive with a detached path —
    // the workspace header button deliberately keeps showing the now-deleted
    // directory name (no other entry becomes selected). The guard is: the row
    // disappears, nothing crashes, and the workspace stays functional.
    const branchName = `test-active-delete-${Date.now()}`

    const dialog = await createWorktree(branchName)

    // The create handler repointed the active session at the new worktree
    const newItem = worktreeOption(dialog, branchName)
    await expect(newItem).toHaveAttribute('aria-selected', 'true')

    // Delete it while the session points at it
    await newItem.hover()
    await newItem.getByRole('button', { name: 'Remove' }).click()
    await newItem.getByRole('button', { name: 'Confirm' }).click()
    await waitForWorktreeGone(dialog, branchName)

    // No worktree is auto-selected in its place …
    await expect(
      dialog.getByRole('listbox', { name: 'Worktrees' }).getByRole('option', { selected: true })
    ).toHaveCount(0)

    // … and the workspace header button still shows the detached directory
    // name, so the user can repoint manually.
    await window.keyboard.press('Escape')
    await expect(dialog).not.toBeVisible()
    await expect
      .poll(async () => await headerWorktreeBranch(window), { timeout: 5_000 })
      .toContain(branchName)
  })

  // ── optimistic delete ──────────────────────────────────────────────────────

  test('deleting one worktree does not block deleting another', async () => {
    // Regression guard: handleRemove used to set a `busy` flag and await the
    // worktree:remove IPC before re-enabling further actions. The result was
    // that queuing a second delete required waiting for `git worktree remove`
    // to finish — visually indistinguishable from the UI being frozen. The
    // fix drops the row optimistically (with a rollback on failure), so the
    // user can fire off the next confirmation immediately.
    const branchA = `test-fast-a-${Date.now()}`
    const branchB = `test-fast-b-${Date.now()}`

    // Create both worktrees up-front.
    await createWorktree(branchA)
    const dialog = await (async () => {
      // createWorktree leaves the popover open; close it so the second create
      // starts from the closed state its helper expects.
      await window.keyboard.press('Escape')
      return createWorktree(branchB)
    })()

    // Open the confirmation on A, confirm — then *immediately* (no wait)
    // confirm B. Both rows should vanish from the list within the standard
    // timeout. If `busy` ever gated the second click, this would time out.
    const a = worktreeOption(dialog, branchA)
    await a.hover()
    await a.getByRole('button', { name: 'Remove' }).click()
    await a.getByRole('button', { name: 'Confirm' }).click()

    const b = worktreeOption(dialog, branchB)
    await b.hover()
    await b.getByRole('button', { name: 'Remove' }).click()
    await b.getByRole('button', { name: 'Confirm' }).click()

    await waitForWorktreeGone(dialog, branchA)
    await waitForWorktreeGone(dialog, branchB)
  })

  // ── main worktree protection ───────────────────────────────────────────────

  test('main worktree does not expose a Remove button', async () => {
    // The main worktree has isMain === true, so WorktreeList.svelte only renders
    // the Remove/Confirm/Cancel buttons inside {#if !worktree.isMain}. There
    // should be no Remove button for any main/master entry.
    const dialog = await openWorktreePopover(window)
    const mainOption = dialog
      .getByRole('listbox', { name: 'Worktrees' })
      .getByRole('option', { name: /\b(main|master)\b/ })
      .first()
    await mainOption.hover()

    // The Remove button must not exist inside the main worktree item at all
    await expect(mainOption.getByRole('button', { name: 'Remove' })).not.toBeVisible()
  })
})
