import { test, expect } from '@playwright/test'
import { _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { MAIN, launchEnv, spawnTerminalSession, clearSavedSessionFile, createTempRepo, removeTempRepo } from './fixtures'

const SANDBOX_ARGS = process.env.CI ? ['--no-sandbox'] : []
const repoPath = process.env.SIMPLEEDIT_TEST_REPO

/**
 * Ported to the agent-first UI: "active worktree" is now a property of the
 * active SESSION (sessions are the primary navigation entity). The Worktrees
 * sidebar still exists as a management section; clicking an entry repoints the
 * active session's workspace, and aria-selected reflects the active session's
 * worktreePath. With no session, nothing is selected — so each selection test
 * spawns a terminal session first. The old "#pane-manager header" is gone; the
 * workspace header's worktree <select> is the new source of truth.
 */

/** The selected branch shown in the visible workspace header's worktree select. */
async function headerWorktreeBranch(window: Page): Promise<string> {
  const select = window
    .getByTitle('Worktree this workspace is pointed at')
    .filter({ visible: true })
    .first()
  return select.evaluate(
    (el) => (el as HTMLSelectElement).selectedOptions[0]?.textContent?.trim() ?? ''
  )
}

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

  test('a new session points at the first (main) worktree, selecting it', async () => {
    // The old "first worktree auto-selected on load" concept is gone — there is
    // no selection until a session exists. New sessions launch in
    // worktreeList()[0], so spawning one selects the first worktree entry.
    await spawnTerminalSession(window)

    const listbox = window.getByRole('listbox', { name: 'Worktrees' })
    const firstOption = listbox.getByRole('option').first()
    await expect(firstOption).toHaveAttribute('aria-selected', 'true')
  })

  test("the session's worktree branch is reflected in the workspace header select", async () => {
    await spawnTerminalSession(window)

    const listbox = window.getByRole('listbox', { name: 'Worktrees' })
    const firstOption = listbox.getByRole('option').first()
    await expect(firstOption).toHaveAttribute('aria-selected', 'true')

    // The branch name text inside the option (the <span class="flex-1 truncate"> child)
    const branchName = await firstOption.locator('span.flex-1').textContent()
    expect(branchName).toBeTruthy()

    await expect
      .poll(async () => await headerWorktreeBranch(window), { timeout: 5_000 })
      .toBe(branchName!.trim())
  })

  test('clicking a different worktree repoints the active session', async () => {
    await spawnTerminalSession(window)

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

    // Workspace header select should update to the newly-pointed branch
    await expect
      .poll(async () => await headerWorktreeBranch(window), { timeout: 5_000 })
      .toBe(secondBranch!.trim())
  })

  test('clicking the already-active worktree keeps it selected', async () => {
    await spawnTerminalSession(window)

    const listbox = window.getByRole('listbox', { name: 'Worktrees' })
    const firstOption = listbox.getByRole('option').first()

    // Ensure it is active first (the new session points at it)
    await expect(firstOption).toHaveAttribute('aria-selected', 'true')

    // Click it again — should remain active without error
    await firstOption.click()
    await expect(firstOption).toHaveAttribute('aria-selected', 'true')
  })

  test('worktree can be activated with keyboard (Enter / Space)', async () => {
    await spawnTerminalSession(window)

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

    await expect
      .poll(async () => await headerWorktreeBranch(window), { timeout: 5_000 })
      .toBe(secondBranch!.trim())
  })

  test('switching back to the first worktree restores the header select', async () => {
    await spawnTerminalSession(window)

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

    // Header select should reflect the first branch again
    await expect
      .poll(async () => await headerWorktreeBranch(window), { timeout: 5_000 })
      .toBe(firstBranch!.trim())
  })
})
