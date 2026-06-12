import { test, expect } from '@playwright/test'
import { _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { MAIN, launchEnv, spawnTerminalSession, clearSavedSessionFile, createTempRepo, removeTempRepo } from './fixtures'

const SANDBOX_ARGS = process.env.CI ? ['--no-sandbox'] : []
const repoPath = process.env.SIMPLEEDIT_TEST_REPO

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

    // Wait for the initial worktree list to load
    const listbox = window.getByRole('listbox', { name: 'Worktrees' })
    await listbox.getByRole('option').first().waitFor()

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

    // The new worktree should appear in the listbox. (No exact before/after
    // count assertion: suites in other workers create/remove worktrees in the
    // same shared repo concurrently, so the total is not stable.)
    await expect(listbox.getByRole('option', { name: branchName })).toBeVisible({
      timeout: 10_000
    })
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

  test('newly created worktree repoints the active session (auto-activate)', async () => {
    // aria-selected reflects the ACTIVE SESSION's worktree in the agent-first
    // UI — with no session, nothing is ever selected. Spawn one first; the
    // create handler then repoints it at the new worktree.
    await spawnTerminalSession(window)

    const branchName = `test-autoselect-${Date.now()}`
    const listbox = window.getByRole('listbox', { name: 'Worktrees' })

    await window.getByRole('button', { name: '+ New' }).click()
    await window.getByPlaceholder('branch-name').fill(branchName)
    await window.getByRole('button', { name: 'Create' }).click()

    // Wait for the new entry to appear
    const newItem = listbox.getByRole('option', { name: new RegExp(branchName) })
    await expect(newItem).toBeVisible({ timeout: 10_000 })

    // It must be the selected worktree immediately — no manual click needed
    await expect(newItem).toHaveAttribute('aria-selected', 'true')
  })

  test('clicking away from the form (focus-out) cancels creation', async () => {
    await window.getByRole('button', { name: '+ New' }).click()
    await expect(window.getByPlaceholder('branch-name')).toBeVisible()

    // Click somewhere outside the form — the sidebar section title is a safe
    // target. exact:true so the transient "No worktrees found" placeholder
    // (visible until the list loads) can't make the locator ambiguous.
    await window.getByText('Worktrees', { exact: true }).click()

    await expect(window.getByPlaceholder('branch-name')).not.toBeVisible()
  })
})
