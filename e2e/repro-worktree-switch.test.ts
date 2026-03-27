import { test, expect } from '@playwright/test'
import { _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { MAIN } from './fixtures'

const SANDBOX_ARGS = process.env.CI ? ['--no-sandbox'] : []
const repoPath = process.env.SIMPLEEDIT_TEST_REPO

test.describe('Switch active worktree', () => {
  test.skip(!repoPath, 'Set SIMPLEEDIT_TEST_REPO to run worktree-switch tests')

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

  test('worktree list is visible in the sidebar', async () => {
    // The worktree listbox is always rendered in the sidebar
    const listbox = window.getByRole('listbox', { name: 'Worktrees' })
    await expect(listbox).toBeVisible()
  })

  test('at least one worktree entry is shown', async () => {
    const listbox = window.getByRole('listbox', { name: 'Worktrees' })
    // Each worktree row is an [role=option] element
    const options = listbox.getByRole('option')
    await expect(options.first()).toBeVisible()
  })

  test('the first worktree is auto-selected on load', async () => {
    const listbox = window.getByRole('listbox', { name: 'Worktrees' })
    const firstOption = listbox.getByRole('option').first()

    // The active item carries aria-selected="true"
    await expect(firstOption).toHaveAttribute('aria-selected', 'true')
  })

  test('active worktree branch name is reflected in the pane header', async () => {
    const listbox = window.getByRole('listbox', { name: 'Worktrees' })
    const firstOption = listbox.getByRole('option').first()

    // The branch name text inside the option (the <span class="flex-1 truncate"> child)
    const branchName = await firstOption.locator('span.flex-1').textContent()
    expect(branchName).toBeTruthy()

    // PaneManager renders the active branch name in the primary pane header
    const paneHeader = window.locator('#pane-manager').locator('span.truncate').first()
    await expect(paneHeader).toHaveText(branchName!.trim())
  })

  test('clicking a different worktree makes it active', async () => {
    const listbox = window.getByRole('listbox', { name: 'Worktrees' })
    const options = listbox.getByRole('option')
    const count = await options.count()

    if (count < 2) {
      test.skip() // only one worktree — switching is not possible
      return
    }

    // Capture the branch name of the second worktree
    const secondOption = options.nth(1)
    const secondBranch = await secondOption.locator('span.flex-1').textContent()
    expect(secondBranch).toBeTruthy()

    // Click the second worktree
    await secondOption.click()

    // It should now carry aria-selected="true"
    await expect(secondOption).toHaveAttribute('aria-selected', 'true')

    // The previously-first option must no longer be selected
    await expect(options.first()).toHaveAttribute('aria-selected', 'false')

    // Pane header should update to the newly-active branch
    const paneHeader = window.locator('#pane-manager').locator('span.truncate').first()
    await expect(paneHeader).toHaveText(secondBranch!.trim())
  })

  test('clicking the already-active worktree keeps it selected', async () => {
    const listbox = window.getByRole('listbox', { name: 'Worktrees' })
    const firstOption = listbox.getByRole('option').first()

    // Ensure it is active first
    await expect(firstOption).toHaveAttribute('aria-selected', 'true')

    // Click it again — should remain active without error
    await firstOption.click()
    await expect(firstOption).toHaveAttribute('aria-selected', 'true')
  })

  test('worktree can be activated with keyboard (Enter / Space)', async () => {
    const listbox = window.getByRole('listbox', { name: 'Worktrees' })
    const options = listbox.getByRole('option')
    const count = await options.count()

    if (count < 2) {
      test.skip()
      return
    }

    const secondOption = options.nth(1)
    const secondBranch = await secondOption.locator('span.flex-1').textContent()

    // Focus the second option and press Enter
    await secondOption.focus()
    await secondOption.press('Enter')

    await expect(secondOption).toHaveAttribute('aria-selected', 'true')

    const paneHeader = window.locator('#pane-manager').locator('span.truncate').first()
    await expect(paneHeader).toHaveText(secondBranch!.trim())
  })

  test('switching back to the first worktree restores its pane state', async () => {
    const listbox = window.getByRole('listbox', { name: 'Worktrees' })
    const options = listbox.getByRole('option')
    const count = await options.count()

    if (count < 2) {
      test.skip()
      return
    }

    const firstOption = options.first()
    const secondOption = options.nth(1)

    const firstBranch = await firstOption.locator('span.flex-1').textContent()

    // Switch to second worktree then back to first
    await secondOption.click()
    await expect(secondOption).toHaveAttribute('aria-selected', 'true')

    await firstOption.click()
    await expect(firstOption).toHaveAttribute('aria-selected', 'true')

    // Pane header should reflect the first branch again
    const paneHeader = window.locator('#pane-manager').locator('span.truncate').first()
    await expect(paneHeader).toHaveText(firstBranch!.trim())
  })
})
