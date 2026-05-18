import { test, expect } from '@playwright/test'
import { _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { MAIN } from './fixtures'

const SANDBOX_ARGS = process.env.CI ? ['--no-sandbox'] : []
const repoPath = process.env.SIMPLEEDIT_TEST_REPO

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Wait for the worktree list to contain a specific branch name.
 * The list uses role="listbox" / role="option" from WorktreeList.svelte.
 */
async function waitForWorktreeItem(window: Page, branchName: string): Promise<void> {
  await expect(
    window.getByRole('listbox', { name: 'Worktrees' }).getByRole('option', { name: new RegExp(branchName) })
  ).toBeVisible({ timeout: 10_000 })
}

/**
 * Wait for a worktree item with the given branch name to disappear.
 */
async function waitForWorktreeGone(window: Page, branchName: string): Promise<void> {
  await expect(
    window.getByRole('listbox', { name: 'Worktrees' }).getByRole('option', { name: new RegExp(branchName) })
  ).not.toBeVisible({ timeout: 10_000 })
}

// ── suite ─────────────────────────────────────────────────────────────────────

test.describe('Delete worktree', () => {
  test.skip(!repoPath, 'Set SIMPLEEDIT_TEST_REPO to run worktree-delete tests')

  let app: ElectronApplication
  let window: Page

  test.beforeEach(async () => {
    app = await electron.launch({
      args: [MAIN, ...SANDBOX_ARGS],
      env: { ...process.env, SIMPLEEDIT_REPO: repoPath! }
    })
    window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
  })

  test.afterEach(async () => {
    await app.close()
  })

  // ── happy path ─────────────────────────────────────────────────────────────

  test('creates a worktree, deletes it via confirmation, verifies it is gone', async () => {
    const branchName = `test-delete-${Date.now()}`

    // --- CREATE ---
    await window.getByRole('button', { name: '+ New' }).click()

    const nameInput = window.getByPlaceholder('branch-name')
    await expect(nameInput).toBeVisible()
    await nameInput.fill(branchName)

    await window.getByRole('button', { name: 'Create' }).click()

    // Worktree should appear in the list
    await waitForWorktreeItem(window, branchName)

    // --- DELETE (two-step confirmation) ---
    const worktreeItem = window
      .getByRole('listbox', { name: 'Worktrees' })
      .getByRole('option', { name: new RegExp(branchName) })

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

    // Worktree must disappear from the list
    await waitForWorktreeGone(window, branchName)
  })

  // ── cancel confirmation ────────────────────────────────────────────────────

  test('cancel during confirmation leaves worktree intact', async () => {
    const branchName = `test-nodelete-${Date.now()}`

    // Create
    await window.getByRole('button', { name: '+ New' }).click()
    const nameInput = window.getByPlaceholder('branch-name')
    await nameInput.fill(branchName)
    await window.getByRole('button', { name: 'Create' }).click()
    await waitForWorktreeItem(window, branchName)

    // Initiate delete
    const worktreeItem = window
      .getByRole('listbox', { name: 'Worktrees' })
      .getByRole('option', { name: new RegExp(branchName) })

    await worktreeItem.hover()
    await worktreeItem.getByRole('button', { name: 'Remove' }).click()

    // Cancel
    await worktreeItem.getByRole('button', { name: 'Cancel' }).click()

    // "Remove" button should be back (confirmation dismissed), worktree still present
    await expect(
      window.getByRole('listbox', { name: 'Worktrees' }).getByRole('option', { name: new RegExp(branchName) })
    ).toBeVisible()

    // Clean up: actually delete the worktree so the repo is left clean
    await worktreeItem.hover()
    await worktreeItem.getByRole('button', { name: 'Remove' }).click()
    await worktreeItem.getByRole('button', { name: 'Confirm' }).click()
    await waitForWorktreeGone(window, branchName)
  })

  // ── delete active worktree ────────────────────────────────────────────────

  test('deleting the active worktree switches pane to another worktree', async () => {
    const branchName = `test-active-delete-${Date.now()}`
    const listbox = window.getByRole('listbox', { name: 'Worktrees' })

    // Create a new worktree
    await window.getByRole('button', { name: '+ New' }).click()
    await window.getByPlaceholder('branch-name').fill(branchName)
    await window.getByRole('button', { name: 'Create' }).click()
    await waitForWorktreeItem(window, branchName)

    // Click the new worktree to make it active
    const newItem = listbox.getByRole('option', { name: new RegExp(branchName) })
    await newItem.click()
    await expect(newItem).toHaveAttribute('aria-selected', 'true')

    // Delete it while it is active
    await newItem.hover()
    await newItem.getByRole('button', { name: 'Remove' }).click()
    await newItem.getByRole('button', { name: 'Confirm' }).click()
    await waitForWorktreeGone(window, branchName)

    // Some other worktree must now be selected — not null / no worktree
    await expect(listbox.getByRole('option', { selected: true })).toBeVisible()
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
    const listbox = window.getByRole('listbox', { name: 'Worktrees' })

    // Create both worktrees up-front.
    for (const name of [branchA, branchB]) {
      await window.getByRole('button', { name: '+ New' }).click()
      await window.getByPlaceholder('branch-name').fill(name)
      await window.getByRole('button', { name: 'Create' }).click()
      await waitForWorktreeItem(window, name)
    }

    // Open the confirmation on A, confirm — then *immediately* (no wait)
    // confirm B. Both rows should vanish from the list within the standard
    // timeout. If `busy` ever gated the second click, this would time out.
    const a = listbox.getByRole('option', { name: new RegExp(branchA) })
    await a.hover()
    await a.getByRole('button', { name: 'Remove' }).click()
    await a.getByRole('button', { name: 'Confirm' }).click()

    const b = listbox.getByRole('option', { name: new RegExp(branchB) })
    await b.hover()
    await b.getByRole('button', { name: 'Remove' }).click()
    await b.getByRole('button', { name: 'Confirm' }).click()

    await waitForWorktreeGone(window, branchA)
    await waitForWorktreeGone(window, branchB)
  })

  // ── main worktree protection ───────────────────────────────────────────────

  test('main worktree does not expose a Remove button', async () => {
    // The main worktree has isMain === true, so WorktreeList.svelte only renders
    // the Remove/Confirm/Cancel buttons inside {#if !worktree.isMain}. There
    // should be no Remove button for any main/master entry.
    const listbox = window.getByRole('listbox', { name: 'Worktrees' })

    // Collect all options whose name contains "main" or "master"
    const mainOption = listbox.getByRole('option', { name: /\b(main|master)\b/ }).first()
    await mainOption.hover()

    // The Remove button must not exist inside the main worktree item at all
    await expect(mainOption.getByRole('button', { name: 'Remove' })).not.toBeVisible()
  })
})
