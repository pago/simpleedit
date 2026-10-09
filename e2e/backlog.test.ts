/**
 * The session backlog end to end: an item saved at the desk survives in main's
 * store, and Start turns it into a session in the sidebar while the item
 * leaves the backlog. The stub `claude` on PATH (e2e/bin) stands in for the
 * agent, so nothing here depends on a real model.
 */
import { test, expect } from '@playwright/test'
import { _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { MAIN, launchEnv, waitForWorktreesReady, clearSavedSessionFile, createTempRepo, removeTempRepo } from './fixtures'

const SANDBOX_ARGS = process.env.CI ? ['--no-sandbox'] : []

test.describe('session backlog', () => {
  let app: ElectronApplication
  let window: Page
  let repo: ReturnType<typeof createTempRepo>

  test.beforeAll(() => {
    repo = createTempRepo('simpleedit-e2e-backlog-')
  })
  test.afterAll(() => {
    removeTempRepo(repo)
  })

  test.beforeEach(async () => {
    clearSavedSessionFile(repo.bareRepoPath)
    app = await electron.launch({
      args: [MAIN, ...SANDBOX_ARGS],
      env: launchEnv({ SIMPLEEDIT_REPO: repo.bareRepoPath }),
    })
    window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await waitForWorktreesReady(window)
  })

  test.afterEach(async () => {
    await app.close()
  })

  test('adds an item at the desk and starts it as a session', async () => {
    await window.getByRole('button', { name: /^Backlog/ }).click()
    await expect(window.getByText('Nothing queued.', { exact: false })).toBeVisible()

    // A new item is only written once it has a prompt; then it saves itself.
    await window.getByRole('button', { name: '+ New' }).click()
    const detail = window.getByTestId('backlog-detail')
    await detail.locator('.monaco-editor').click()
    await window.keyboard.type('Summarise the README for a new contributor')
    await detail.getByLabel('Session name').fill('backlog e2e')

    const row = window.getByTestId('backlog-item')
    await expect(row).toHaveCount(1)
    await expect(row).toContainText('backlog e2e')
    await expect(detail.getByRole('status')).toHaveText('Saved')

    // Main owns the item: it is there for any client that asks.
    const stored = await window.evaluate(() =>
      (window as unknown as { api: { invoke: (ch: string) => Promise<{ items: Array<{ prompt: string; label?: string }> }> } }).api
        .invoke('backlog:load')
        .then((s) => s.items.map((i) => [i.prompt, i.label])),
    )
    expect(stored).toEqual([['Summarise the README for a new contributor', 'backlog e2e']])

    await row.getByRole('button', { name: 'Start' }).click()
    // The new session opens in the workspace; the item has left the backlog.
    await expect(window.getByText('backlog e2e').first()).toBeVisible()
    await window.getByRole('button', { name: /^Backlog/ }).click()
    await expect(window.getByTestId('backlog-item')).toHaveCount(0)
  })
})
