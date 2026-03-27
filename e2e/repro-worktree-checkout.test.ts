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
 * Run with:
 *   SIMPLEEDIT_TEST_REPO=/path/to/repo.git pnpm test:e2e -- repro-worktree-checkout.test
 */

import { test, expect } from '@playwright/test'
import { _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { MAIN } from './fixtures'

const SANDBOX_ARGS = process.env.CI ? ['--no-sandbox'] : []
const repoPath = process.env.SIMPLEEDIT_TEST_REPO

test.describe('Checkout remote branch as worktree', () => {
  test.skip(!repoPath, 'Set SIMPLEEDIT_TEST_REPO to run worktree checkout tests')

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

  test('Checkout button is visible in the sidebar header', async () => {
    // The sidebar contains the worktrees section with "Checkout" and "+ New" buttons
    const sidebar = window.getByRole('complementary')
    await expect(sidebar).toBeVisible()
    await expect(sidebar.getByRole('button', { name: 'Checkout' })).toBeVisible()
  })

  test('clicking Checkout opens the branch filter input', async () => {
    const sidebar = window.getByRole('complementary')
    await sidebar.getByRole('button', { name: 'Checkout' }).click()

    // The checkout panel shows a filter input and a branch list
    const filterInput = sidebar.getByPlaceholder('Filter branches…')
    await expect(filterInput).toBeVisible()
  })

  test('checkout panel shows the branch list (or empty-state message)', async () => {
    const sidebar = window.getByRole('complementary')
    await sidebar.getByRole('button', { name: 'Checkout' }).click()

    // Either branch buttons appear, or an empty-state message is shown
    const listContainer = sidebar.locator('div.max-h-40')
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
    const sidebar = window.getByRole('complementary')
    await sidebar.getByRole('button', { name: 'Checkout' }).click()

    const listContainer = sidebar.locator('div.max-h-40')
    const allBranches = await listContainer.getByRole('button').count()

    if (allBranches === 0) {
      test.skip(true, 'No branches available — skipping filter test')
    }

    // Read the first branch name so we can filter specifically for it
    const firstBranchText = await listContainer.getByRole('button').first().textContent()
    expect(firstBranchText).toBeTruthy()

    // Type a filter that matches only the first branch
    const filterInput = sidebar.getByPlaceholder('Filter branches…')
    await filterInput.fill(firstBranchText!.trim())

    // The list should narrow to exactly one result
    await expect(listContainer.getByRole('button')).toHaveCount(1)
    await expect(listContainer.getByRole('button').first()).toHaveText(firstBranchText!.trim())
  })

  test('Escape key dismisses the checkout panel', async () => {
    const sidebar = window.getByRole('complementary')
    await sidebar.getByRole('button', { name: 'Checkout' }).click()

    const filterInput = sidebar.getByPlaceholder('Filter branches…')
    await expect(filterInput).toBeVisible()

    await filterInput.press('Escape')

    await expect(filterInput).not.toBeVisible()
    // The "Checkout" header button should be visible again
    await expect(sidebar.getByRole('button', { name: 'Checkout' })).toBeVisible()
  })

  test('Cancel button dismisses the checkout panel', async () => {
    const sidebar = window.getByRole('complementary')
    await sidebar.getByRole('button', { name: 'Checkout' }).click()

    await expect(sidebar.getByPlaceholder('Filter branches…')).toBeVisible()

    await sidebar.getByRole('button', { name: 'Cancel' }).click()

    await expect(sidebar.getByPlaceholder('Filter branches…')).not.toBeVisible()
    await expect(sidebar.getByRole('button', { name: 'Checkout' })).toBeVisible()
  })

  test('the Checkout confirm button is disabled until a branch is selected', async () => {
    const sidebar = window.getByRole('complementary')
    await sidebar.getByRole('button', { name: 'Checkout' }).click()

    // The confirm "Checkout" button inside the panel (not the header trigger)
    // It is the last button in the footer row inside the checkout panel
    const confirmButton = sidebar.locator('div.flex.justify-end.gap-1').getByRole('button', {
      name: 'Checkout'
    })
    await expect(confirmButton).toBeDisabled()
  })

  test('selecting a branch enables the Checkout confirm button', async () => {
    const sidebar = window.getByRole('complementary')
    await sidebar.getByRole('button', { name: 'Checkout' }).click()

    const listContainer = sidebar.locator('div.max-h-40')
    const allBranches = await listContainer.getByRole('button').count()

    if (allBranches === 0) {
      test.skip(true, 'No branches available — skipping selection test')
    }

    // Click the first branch in the list
    await listContainer.getByRole('button').first().click()

    // The confirm button should now be enabled
    const confirmButton = sidebar.locator('div.flex.justify-end.gap-1').getByRole('button', {
      name: 'Checkout'
    })
    await expect(confirmButton).toBeEnabled()
  })

  test('checking out a branch creates a new worktree entry in the list', async () => {
    const sidebar = window.getByRole('complementary')

    // Capture the worktree list before checkout
    const listbox = sidebar.getByRole('listbox', { name: 'Worktrees' })
    const countBefore = await listbox.getByRole('option').count()

    await sidebar.getByRole('button', { name: 'Checkout' }).click()

    const listContainer = sidebar.locator('div.max-h-40')
    const allBranches = await listContainer.getByRole('button').count()

    if (allBranches === 0) {
      test.skip(true, 'No branches available — skipping checkout creation test')
    }

    // Read the branch name we're about to check out
    const targetBranch = (await listContainer.getByRole('button').first().textContent())!.trim()

    // Select the branch and confirm
    await listContainer.getByRole('button').first().click()
    const confirmButton = sidebar.locator('div.flex.justify-end.gap-1').getByRole('button', {
      name: 'Checkout'
    })
    await confirmButton.click()

    // The checkout panel should close
    await expect(sidebar.getByPlaceholder('Filter branches…')).not.toBeVisible()

    // The worktree list should now have one more entry
    await expect(listbox.getByRole('option')).toHaveCount(countBefore + 1)

    // The new entry should display the checked-out branch name
    await expect(listbox.getByRole('option', { name: new RegExp(targetBranch) })).toBeVisible()
  })

  test('double-clicking a branch immediately checks it out', async () => {
    const sidebar = window.getByRole('complementary')
    const listbox = sidebar.getByRole('listbox', { name: 'Worktrees' })
    const countBefore = await listbox.getByRole('option').count()

    await sidebar.getByRole('button', { name: 'Checkout' }).click()

    const listContainer = sidebar.locator('div.max-h-40')
    const allBranches = await listContainer.getByRole('button').count()

    if (allBranches === 0) {
      test.skip(true, 'No branches available — skipping double-click test')
    }

    const targetBranch = (await listContainer.getByRole('button').first().textContent())!.trim()

    // Double-click triggers handleCreate directly (ondblclick handler in the template)
    await listContainer.getByRole('button').first().dblclick()

    // Panel should close
    await expect(sidebar.getByPlaceholder('Filter branches…')).not.toBeVisible()

    // Worktree list grows by one
    await expect(listbox.getByRole('option')).toHaveCount(countBefore + 1)
    await expect(listbox.getByRole('option', { name: new RegExp(targetBranch) })).toBeVisible()
  })
})
