/**
 * E2E tests for the "checkout a branch from remote origin" flow.
 *
 * Prerequisites:
 *   - SIMPLEEDIT_TEST_REPO must point to a bare git repo
 *   - The repo must have at least one branch NOT currently checked out as a
 *     worktree (i.e. an existing local or remote-tracking branch that is
 *     available for checkout). If every branch is already a worktree the
 *     branch list will be empty and these tests will be skipped.
 *
 * As of f1e6062 the WorktreeList (with its Checkout flow) lives in the
 * workspace header's worktree popover (role="dialog" aria-label="Worktrees"),
 * so each test spawns a session and opens the popover. Esc closes the whole
 * popover; checking out closes it too (it repoints the active session).
 *
 * Run with:
 *   SIMPLEEDIT_TEST_REPO=/path/to/repo.git pnpm test:e2e -- repro-worktree-checkout.test
 */

import { test, expect } from '@playwright/test'
import { _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page, Locator } from '@playwright/test'
import {
  MAIN,
  launchEnv,
  spawnTerminalSession,
  clearSavedSessionFile,
  openWorktreePopover
} from './fixtures'

const SANDBOX_ARGS = process.env.CI ? ['--no-sandbox'] : []
const repoPath = process.env.SIMPLEEDIT_TEST_REPO

test.describe('Checkout remote branch as worktree', () => {
  test.skip(!repoPath, 'Set SIMPLEEDIT_TEST_REPO to run worktree checkout tests')

  let app: ElectronApplication
  let window: Page

  test.beforeEach(async () => {
    clearSavedSessionFile(repoPath!)
    app = await electron.launch({
      args: [MAIN, ...SANDBOX_ARGS],
      env: launchEnv({ SIMPLEEDIT_REPO: repoPath! })
    })
    window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await spawnTerminalSession(window)
  })

  test.afterEach(async () => {
    await app.close()
  })

  /** Open the worktree popover (where the Checkout flow lives). */
  async function openPopover(): Promise<Locator> {
    return openWorktreePopover(window)
  }

  test('Checkout button is visible in the worktree popover', async () => {
    const dialog = await openPopover()
    await expect(dialog.getByRole('button', { name: 'Checkout' })).toBeVisible()
  })

  test('clicking Checkout opens the branch filter input', async () => {
    const dialog = await openPopover()
    await dialog.getByRole('button', { name: 'Checkout' }).click()

    // The checkout panel shows a filter input and a branch list
    const filterInput = dialog.getByPlaceholder('Filter branches…')
    await expect(filterInput).toBeVisible()
  })

  test('checkout panel shows the branch list (or empty-state message)', async () => {
    const dialog = await openPopover()
    await dialog.getByRole('button', { name: 'Checkout' }).click()

    // Either branch buttons appear, or an empty-state message is shown
    const listContainer = dialog.locator('div.max-h-40')
    await expect(listContainer).toBeVisible()

    // Wait for loading to finish (busy state shows "Loading…" while fetching)
    await expect(listContainer.getByText('Loading…')).not.toBeVisible({ timeout: 10_000 })

    const branchCount = await listContainer.getByRole('button').count()
    const emptyMsg = listContainer.getByText(/No branches available|No matches/)

    if (branchCount === 0) {
      // No branches available — empty-state message must be present
      await expect(emptyMsg).toBeVisible()
      test.info().annotations.push({
        type: 'skip-reason',
        description: 'No branches available for checkout in this repo'
      })
    } else {
      // At least one branch entry is present
      expect(branchCount).toBeGreaterThan(0)
    }
  })

  test('filtering the branch list narrows results', async () => {
    const dialog = await openPopover()
    await dialog.getByRole('button', { name: 'Checkout' }).click()

    const listContainer = dialog.locator('div.max-h-40')
    const allBranches = await listContainer.getByRole('button').count()

    if (allBranches === 0) {
      test.skip(true, 'No branches available — skipping filter test')
    }

    // Read the first branch name so we can filter specifically for it
    const firstBranchText = await listContainer.getByRole('button').first().textContent()
    expect(firstBranchText).toBeTruthy()

    // Type a filter that matches only the first branch
    const filterInput = dialog.getByPlaceholder('Filter branches…')
    await filterInput.fill(firstBranchText!.trim())

    // The list should narrow to exactly one result
    await expect(listContainer.getByRole('button')).toHaveCount(1)
    await expect(listContainer.getByRole('button').first()).toHaveText(firstBranchText!.trim())
  })

  test('Escape key dismisses the checkout panel (with the popover)', async () => {
    const dialog = await openPopover()
    await dialog.getByRole('button', { name: 'Checkout' }).click()

    const filterInput = dialog.getByPlaceholder('Filter branches…')
    await expect(filterInput).toBeVisible()

    // Esc closes the whole popover (checkout panel included)
    await filterInput.press('Escape')
    await expect(window.getByPlaceholder('Filter branches…')).not.toBeVisible()

    // Reopening shows the default panel with the "Checkout" header button again
    const reopened = await openPopover()
    await expect(reopened.getByRole('button', { name: 'Checkout' })).toBeVisible()
  })

  test('Cancel button dismisses the checkout panel', async () => {
    const dialog = await openPopover()
    await dialog.getByRole('button', { name: 'Checkout' }).click()

    await expect(dialog.getByPlaceholder('Filter branches…')).toBeVisible()

    await dialog.getByRole('button', { name: 'Cancel' }).click()

    // Cancel keeps the popover open, only the checkout panel closes
    await expect(dialog.getByPlaceholder('Filter branches…')).not.toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Checkout' })).toBeVisible()
  })

  test('the Checkout confirm button is disabled until a branch is selected', async () => {
    const dialog = await openPopover()
    await dialog.getByRole('button', { name: 'Checkout' }).click()

    // The confirm "Checkout" button inside the panel (not the header trigger)
    // It is the last button in the footer row inside the checkout panel
    const confirmButton = dialog.locator('div.flex.justify-end.gap-1').getByRole('button', {
      name: 'Checkout'
    })
    await expect(confirmButton).toBeDisabled()
  })

  test('selecting a branch enables the Checkout confirm button', async () => {
    const dialog = await openPopover()
    await dialog.getByRole('button', { name: 'Checkout' }).click()

    const listContainer = dialog.locator('div.max-h-40')
    const allBranches = await listContainer.getByRole('button').count()

    if (allBranches === 0) {
      test.skip(true, 'No branches available — skipping selection test')
    }

    // Click the first branch in the list
    await listContainer.getByRole('button').first().click()

    // The confirm button should now be enabled
    const confirmButton = dialog.locator('div.flex.justify-end.gap-1').getByRole('button', {
      name: 'Checkout'
    })
    await expect(confirmButton).toBeEnabled()
  })

  test('checking out a branch creates a new worktree entry in the list', async () => {
    let dialog = await openPopover()

    // Capture the worktree list before checkout
    const countBefore = await dialog
      .getByRole('listbox', { name: 'Worktrees' })
      .getByRole('option')
      .count()

    await dialog.getByRole('button', { name: 'Checkout' }).click()

    const listContainer = dialog.locator('div.max-h-40')
    const allBranches = await listContainer.getByRole('button').count()

    if (allBranches === 0) {
      test.skip(true, 'No branches available — skipping checkout creation test')
    }

    // Read the branch name we're about to check out
    const targetBranch = (await listContainer.getByRole('button').first().textContent())!.trim()

    // Select the branch and confirm
    await listContainer.getByRole('button').first().click()
    const confirmButton = dialog.locator('div.flex.justify-end.gap-1').getByRole('button', {
      name: 'Checkout'
    })
    await confirmButton.click()

    // Checking out repoints the active session and closes the popover
    await expect(dialog).not.toBeVisible({ timeout: 10_000 })

    // Reopen: the worktree list has one more entry, including the new branch
    dialog = await openPopover()
    const options = dialog.getByRole('listbox', { name: 'Worktrees' }).getByRole('option')
    await expect(options).toHaveCount(countBefore + 1)
    await expect(options.filter({ hasText: targetBranch })).toBeVisible()
  })

  test('double-clicking a branch immediately checks it out', async () => {
    let dialog = await openPopover()
    const countBefore = await dialog
      .getByRole('listbox', { name: 'Worktrees' })
      .getByRole('option')
      .count()

    await dialog.getByRole('button', { name: 'Checkout' }).click()

    const listContainer = dialog.locator('div.max-h-40')
    const allBranches = await listContainer.getByRole('button').count()

    if (allBranches === 0) {
      test.skip(true, 'No branches available — skipping double-click test')
    }

    const targetBranch = (await listContainer.getByRole('button').first().textContent())!.trim()

    // Double-click triggers handleCreate directly (ondblclick handler in the template)
    await listContainer.getByRole('button').first().dblclick()

    // Popover closes on checkout; reopen and the worktree list grew by one
    await expect(dialog).not.toBeVisible({ timeout: 10_000 })
    dialog = await openPopover()
    const options = dialog.getByRole('listbox', { name: 'Worktrees' }).getByRole('option')
    await expect(options).toHaveCount(countBefore + 1)
    await expect(options.filter({ hasText: targetBranch })).toBeVisible()
  })
})
