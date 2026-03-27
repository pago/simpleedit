import { test, expect } from '@playwright/test'
import { _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { MAIN } from './fixtures'

const SANDBOX_ARGS = process.env.CI ? ['--no-sandbox'] : []
const repoPath = process.env.SIMPLEEDIT_TEST_REPO

test.describe('Add new worktree', () => {
  test.skip(!repoPath, 'Set SIMPLEEDIT_TEST_REPO to run worktree tests')

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

  test('shows the worktrees section in the sidebar', async () => {
    await expect(window.getByText('Worktrees', { exact: true })).toBeVisible()
    await expect(window.getByRole('button', { name: '+ New' })).toBeVisible()
  })

  test('clicking "+ New" reveals the branch name input', async () => {
    await window.getByRole('button', { name: '+ New' }).click()

    const input = window.getByPlaceholder('branch-name')
    await expect(input).toBeVisible()
    await expect(input).toBeFocused()

    // Create button should be disabled until a name is typed
    const createBtn = window.getByRole('button', { name: 'Create' })
    await expect(createBtn).toBeVisible()
    await expect(createBtn).toBeDisabled()
  })

  test('Escape key cancels the create form', async () => {
    await window.getByRole('button', { name: '+ New' }).click()
    await expect(window.getByPlaceholder('branch-name')).toBeVisible()

    await window.keyboard.press('Escape')
    await expect(window.getByPlaceholder('branch-name')).not.toBeVisible()
  })

  test('Create button becomes enabled after typing a valid branch name', async () => {
    await window.getByRole('button', { name: '+ New' }).click()

    const input = window.getByPlaceholder('branch-name')
    const createBtn = window.getByRole('button', { name: 'Create' })

    await input.fill('my-feature')
    await expect(createBtn).toBeEnabled()
  })

  test('illegal characters are stripped from the branch name input', async () => {
    await window.getByRole('button', { name: '+ New' }).click()

    const input = window.getByPlaceholder('branch-name')
    // Type characters that are illegal in git branch names (spaces, ~, ^)
    await input.type('my feature~branch^name')

    // The sanitizer should strip spaces, ~ and ^ leaving only valid chars
    const value = await input.inputValue()
    expect(value).not.toContain(' ')
    expect(value).not.toContain('~')
    expect(value).not.toContain('^')
  })

  test('creates a new worktree and it appears in the list', async () => {
    const branchName = `test-worktree-${Date.now()}`

    // Wait for the initial worktree list to load before counting
    const listbox = window.getByRole('listbox', { name: 'Worktrees' })
    await listbox.getByRole('option').first().waitFor()
    const beforeCount = await listbox.getByRole('option').count()

    // Click "+ New" and type the branch name
    await window.getByRole('button', { name: '+ New' }).click()

    const input = window.getByPlaceholder('branch-name')
    await input.fill(branchName)

    // Confirm via the Create button
    const createBtn = window.getByRole('button', { name: 'Create' })
    await expect(createBtn).toBeEnabled()
    await createBtn.click()

    // The form should close
    await expect(input).not.toBeVisible()

    // The new worktree should appear in the listbox
    await expect(listbox.getByRole('option', { name: branchName })).toBeVisible({
      timeout: 10_000
    })

    // The list should have grown by one entry
    const afterCount = await listbox.getByRole('option').count()
    expect(afterCount).toBe(beforeCount + 1)
  })

  test('creates a new worktree via Enter key', async () => {
    const branchName = `test-enter-${Date.now()}`

    await window.getByRole('button', { name: '+ New' }).click()

    const input = window.getByPlaceholder('branch-name')
    await input.fill(branchName)
    await input.press('Enter')

    // The form should dismiss
    await expect(input).not.toBeVisible()

    // The worktree should appear
    const listbox = window.getByRole('listbox', { name: 'Worktrees' })
    await expect(listbox.getByRole('option', { name: branchName })).toBeVisible({
      timeout: 10_000
    })
  })

  test('clicking away from the form (focus-out) cancels creation', async () => {
    await window.getByRole('button', { name: '+ New' }).click()
    await expect(window.getByPlaceholder('branch-name')).toBeVisible()

    // Click somewhere outside the form — the sidebar title is a safe target
    await window.getByText('Worktrees').click()

    await expect(window.getByPlaceholder('branch-name')).not.toBeVisible()
  })
})
