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
  openWorktreePopover
} from './fixtures'

const SANDBOX_ARGS = process.env.CI ? ['--no-sandbox'] : []
const repoPath = process.env.SIMPLEEDIT_TEST_REPO

/**
 * As of f1e6062 worktree management lives in the workspace header's worktree
 * popover (role="dialog" aria-label="Worktrees"), not the sidebar. Every test
 * spawns a session (the header only exists inside a workspace) and opens the
 * popover first. Creating a worktree closes the popover, so post-create list
 * assertions reopen it.
 */
test.describe('Add new worktree', () => {
  test.skip(!repoPath, 'Set SIMPLEEDIT_TEST_REPO to run worktree tests')

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

  /** Spawn a session and open the worktree popover. */
  async function openPopover(): Promise<Locator> {
    await spawnTerminalSession(window)
    return openWorktreePopover(window)
  }

  test('worktree management lives in the popover, not the sidebar', async () => {
    const dialog = await openPopover()
    await expect(dialog.getByText('Worktrees', { exact: true })).toBeVisible()
    await expect(dialog.getByRole('button', { name: '+ New' })).toBeVisible()
    // The sidebar is sessions-only now.
    await expect(
      window.getByRole('complementary').getByRole('listbox', { name: 'Worktrees' })
    ).toHaveCount(0)
  })

  test('clicking "+ New" reveals the branch name input', async () => {
    const dialog = await openPopover()
    await dialog.getByRole('button', { name: '+ New' }).click()

    const input = dialog.getByPlaceholder('branch-name')
    await expect(input).toBeVisible()
    await expect(input).toBeFocused()

    // Create button should be disabled until a name is typed
    const createBtn = dialog.getByRole('button', { name: 'Create' })
    await expect(createBtn).toBeVisible()
    await expect(createBtn).toBeDisabled()
  })

  test('Escape key cancels the create form', async () => {
    const dialog = await openPopover()
    await dialog.getByRole('button', { name: '+ New' }).click()
    await expect(dialog.getByPlaceholder('branch-name')).toBeVisible()

    await window.keyboard.press('Escape')
    await expect(window.getByPlaceholder('branch-name')).not.toBeVisible()
  })

  test('Create button becomes enabled after typing a valid branch name', async () => {
    const dialog = await openPopover()
    await dialog.getByRole('button', { name: '+ New' }).click()

    const input = dialog.getByPlaceholder('branch-name')
    const createBtn = dialog.getByRole('button', { name: 'Create' })

    await input.fill('my-feature')
    await expect(createBtn).toBeEnabled()
  })

  test('illegal characters are stripped from the branch name input', async () => {
    const dialog = await openPopover()
    await dialog.getByRole('button', { name: '+ New' }).click()

    const input = dialog.getByPlaceholder('branch-name')
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

    let dialog = await openPopover()
    await dialog
      .getByRole('listbox', { name: 'Worktrees' })
      .getByRole('option')
      .first()
      .waitFor()

    // Click "+ New" and type the branch name
    await dialog.getByRole('button', { name: '+ New' }).click()

    const input = dialog.getByPlaceholder('branch-name')
    await input.fill(branchName)

    // Confirm via the Create button
    const createBtn = dialog.getByRole('button', { name: 'Create' })
    await expect(createBtn).toBeEnabled()
    await createBtn.click()

    // Creating closes the popover; reopen to see the list.
    await expect(dialog).not.toBeVisible({ timeout: 10_000 })
    dialog = await openWorktreePopover(window)
    await expect(
      dialog
        .getByRole('listbox', { name: 'Worktrees' })
        .getByRole('option', { name: branchName })
    ).toBeVisible({ timeout: 10_000 })
  })

  test('creates a new worktree via Enter key', async () => {
    const branchName = `test-enter-${Date.now()}`

    let dialog = await openPopover()
    await dialog.getByRole('button', { name: '+ New' }).click()

    const input = dialog.getByPlaceholder('branch-name')
    await input.fill(branchName)
    await input.press('Enter')

    // Creating closes the popover; reopen and the worktree should appear.
    await expect(dialog).not.toBeVisible({ timeout: 10_000 })
    dialog = await openWorktreePopover(window)
    await expect(
      dialog
        .getByRole('listbox', { name: 'Worktrees' })
        .getByRole('option', { name: branchName })
    ).toBeVisible({ timeout: 10_000 })
  })

  test('newly created worktree repoints the active session (auto-activate)', async () => {
    // aria-selected reflects the ACTIVE SESSION's worktree — the create
    // handler repoints it at the new worktree.
    const branchName = `test-autoselect-${Date.now()}`

    let dialog = await openPopover()
    await dialog.getByRole('button', { name: '+ New' }).click()
    await dialog.getByPlaceholder('branch-name').fill(branchName)
    await dialog.getByRole('button', { name: 'Create' }).click()

    // Creating closes the popover; reopen to inspect selection.
    await expect(dialog).not.toBeVisible({ timeout: 10_000 })
    dialog = await openWorktreePopover(window)

    const newItem = dialog
      .getByRole('listbox', { name: 'Worktrees' })
      .getByRole('option', { name: new RegExp(branchName) })
    await expect(newItem).toBeVisible({ timeout: 10_000 })

    // It must be the selected worktree immediately — no manual click needed
    await expect(newItem).toHaveAttribute('aria-selected', 'true')
  })

  test('clicking away from the form closes the popover (and the form with it)', async () => {
    const dialog = await openPopover()
    await dialog.getByRole('button', { name: '+ New' }).click()
    await expect(dialog.getByPlaceholder('branch-name')).toBeVisible()

    // Click somewhere outside the popover — the sidebar Sessions title is a
    // safe target. Click-outside closes the whole popover, form included.
    await window.getByText('Sessions', { exact: true }).click()

    await expect(window.getByPlaceholder('branch-name')).not.toBeVisible()
    await expect(dialog).not.toBeVisible()
  })
})
