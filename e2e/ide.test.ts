import { test, expect } from '@playwright/test'
import { _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { MAIN } from './fixtures'

const SANDBOX_ARGS = process.env.CI ? ['--no-sandbox'] : []

const repoPath = process.env.SIMPLEEDIT_TEST_REPO

// These tests require a bare git repo. Set SIMPLEEDIT_TEST_REPO to its path.
// Example: SIMPLEEDIT_TEST_REPO=/path/to/repo.git pnpm test:e2e
test.describe('IDE layout', () => {
  test.skip(!repoPath, 'Set SIMPLEEDIT_TEST_REPO to run IDE tests')

  let app: ElectronApplication
  let window: Page
  let pageErrors: string[]

  test.beforeEach(async () => {
    app = await electron.launch({
      args: [MAIN, ...SANDBOX_ARGS],
      env: { ...process.env, SIMPLEEDIT_REPO: repoPath! }
    })
    window = await app.firstWindow()
    pageErrors = []
    window.on('pageerror', (err) => { pageErrors.push(`${err.name}: ${err.message}`) })
    await window.waitForLoadState('domcontentloaded')
  })

  test.afterEach(async () => {
    await app.close()
  })

  test('shows the repo name in the title bar', async () => {
    const repoName = repoPath!.split('/').pop()!.replace('.git', '')
    await expect(window.getByText(`SimpleEdit [${repoName}]`)).toBeVisible()
  })

  test('shows the sidebar', async () => {
    await expect(window.getByRole('complementary')).toBeVisible()
  })

  // Regression guard: a render-time ReferenceError in WorktreePane (e.g. the
  // dangling `{activeFilePath}` introduced when the tabs refactor and the
  // "select opened file" PR collided) aborts Svelte's reactive batch and
  // leaves the git log effect stuck. The visible symptom — sidebar mounts but
  // commits never appear — used to slip past the bare 'shows the sidebar'
  // check above.
  test('git log loads and the renderer does not throw on startup', async () => {
    await expect(window.getByRole('listbox', { name: 'Worktrees' })).toBeVisible()
    await expect(window.getByRole('listbox', { name: 'Commits' })).toBeVisible({ timeout: 5000 })
    expect(pageErrors).toEqual([])
  })
})

test.describe('Terminal links', () => {
  test.skip(!repoPath, 'Set SIMPLEEDIT_TEST_REPO to run IDE tests')

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

  test('app:open-external IPC channel opens URLs in default browser', async () => {
    // Intercept shell.openExternal to capture the URL without opening a browser
    await app.evaluate(({ shell }) => {
      ;(globalThis as Record<string, unknown>).__openedUrl = null
      shell.openExternal = async (url: string) => {
        ;(globalThis as Record<string, unknown>).__openedUrl = url
      }
    })

    await window.evaluate(() =>
      window.api.invoke('app:open-external', 'https://example.com')
    )

    const openedUrl = await app.evaluate(() => {
      return (globalThis as Record<string, unknown>).__openedUrl
    })

    expect(openedUrl).toBe('https://example.com')
  })
})

test.describe('Claude terminal tabs', () => {
  test.skip(!repoPath, 'Set SIMPLEEDIT_TEST_REPO to run IDE tests')

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

  test('each Claude button click creates exactly one terminal', async () => {
    const before: string[] = await window.evaluate(() => window.api.invoke('pty:active-ids'))
    const claudeBefore = before.filter((id) => id.startsWith('claude-'))

    await window.getByTitle('Run Claude Code').first().click()
    await window.waitForTimeout(1000)

    const after: string[] = await window.evaluate(() => window.api.invoke('pty:active-ids'))
    const claudeAfter = after.filter((id) => id.startsWith('claude-'))

    expect(claudeAfter.length).toBe(claudeBefore.length + 1)
  })

  test('switching tabs does not collapse terminal columns to zero (#37)', async () => {
    // Wait for the default terminal tab to stabilise
    await window.waitForTimeout(1000)

    // Create a second terminal tab and switch between them repeatedly
    await window.getByTitle('New terminal').first().click()
    await window.waitForTimeout(500)

    const tabButtons = window.locator(
      'div.flex.items-center.border-b.border-zinc-800 button'
    )
    const allButtons = await tabButtons.all()

    // Switch back to first tab
    for (const btn of allButtons) {
      const text = await btn.textContent()
      if (text?.includes('Terminal 1')) {
        await btn.click()
        break
      }
    }
    await window.waitForTimeout(500)

    // Rapid tab switching to trigger ResizeObserver on hidden containers
    for (let i = 0; i < 3; i++) {
      for (const btn of allButtons) {
        if ((await btn.textContent())?.includes('Terminal 2')) {
          await btn.click()
          break
        }
      }
      await window.waitForTimeout(200)
      for (const btn of allButtons) {
        if ((await btn.textContent())?.includes('Terminal 1')) {
          await btn.click()
          break
        }
      }
      await window.waitForTimeout(200)
    }
    await window.waitForTimeout(500)

    // Write `tput cols` and read the output from the terminal DOM
    const termIds: string[] = await window.evaluate(() =>
      window.api.invoke('pty:active-ids')
    )
    const firstTermId = termIds.find((id) => id.startsWith('term-'))!
    await window.evaluate(
      (id) => window.api.invoke('pty:write', id, 'tput cols\r'),
      firstTermId
    )
    await window.waitForTimeout(1000)

    const cols = await window.evaluate(() => {
      const rows = document.querySelectorAll('.xterm-rows > div')
      for (const row of rows) {
        const text = row.textContent?.trim() ?? ''
        if (/^\d+$/.test(text)) return parseInt(text, 10)
      }
      return null
    })

    expect(cols).not.toBeNull()
    expect(cols!).toBeGreaterThanOrEqual(40)
  })

  test('exiting one Claude terminal does not close the other', async () => {
    await window.evaluate(() => {
      ;(window as any).__exitEvents = [] as string[]
      window.api.on('pty:exit', (payload) => {
        ;(window as any).__exitEvents.push(payload.id)
      })
    })

    await window.getByTitle('Run Claude Code').first().click()
    await window.waitForTimeout(4000)
    await window.getByTitle('Run Claude Code').first().click()
    await window.waitForTimeout(4000)

    const allIds: string[] = await window.evaluate(() => window.api.invoke('pty:active-ids'))
    const claudeIds = allIds.filter((id) => id.startsWith('claude-'))
    expect(claudeIds.length).toBeGreaterThanOrEqual(2)

    const [id1, id2] = claudeIds
    await window.evaluate((id) => window.api.invoke('pty:write', id as string, '/exit\r'), id1)
    await window.waitForTimeout(4000)

    const activeAfter: string[] = await window.evaluate(() => window.api.invoke('pty:active-ids'))
    expect(activeAfter).not.toContain(id1)
    expect(activeAfter).toContain(id2)
  })
})
