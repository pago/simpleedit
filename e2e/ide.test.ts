import { test, expect } from '@playwright/test'
import { _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import {
  MAIN,
  launchEnv,
  waitForWorktreesReady,
  spawnTerminalSession,
  openWorkspaceViewer,
  clearSavedSessionFile, createTempRepo, removeTempRepo } from './fixtures'

const SANDBOX_ARGS = process.env.CI ? ['--no-sandbox'] : []

const repoPath = process.env.SIMPLEEDIT_TEST_REPO

// These tests require a bare git repo. Set SIMPLEEDIT_TEST_REPO to its path.
// Example: SIMPLEEDIT_TEST_REPO=/path/to/repo.git pnpm test:e2e
test.describe('IDE layout', () => {
  test.skip(!repoPath, 'Set SIMPLEEDIT_TEST_REPO to run IDE tests')

  let app: ElectronApplication
  let window: Page
  let pageErrors: string[]

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
    pageErrors = []
    window.on('pageerror', (err) => { pageErrors.push(`${err.name}: ${err.message}`) })
    await window.waitForLoadState('domcontentloaded')
  })

  test.afterEach(async () => {
    await app.close()
  })

  test('shows the repo name in the title bar', async () => {
    const repoName = repo.bareRepoPath.split('/').pop()!.replace('.git', '')
    await expect(window.getByText(`SimpleEdit [${repoName}]`)).toBeVisible()
  })

  test('shows the sidebar', async () => {
    await expect(window.getByRole('complementary')).toBeVisible()
  })

  // Regression guard: a render-time ReferenceError in the workspace tree
  // aborts Svelte's reactive batch and leaves the git log effect stuck. The
  // visible symptom — the workspace mounts but commits never appear — used to
  // slip past the bare 'shows the sidebar' check above. GitLog lives inside a
  // session workspace now, so spawn a session and open the viewer first.
  test('git log loads and the renderer does not throw on startup', async () => {
    // The sidebar is sessions-only as of f1e6062 — no worktree list in it.
    await expect(
      window.getByRole('complementary').getByRole('listbox', { name: 'Worktrees' })
    ).toHaveCount(0)
    await spawnTerminalSession(window)
    await openWorkspaceViewer(window)
    await expect(
      window.getByRole('listbox', { name: 'Commits' }).filter({ visible: true }).first()
    ).toBeVisible({ timeout: 5000 })
    expect(pageErrors).toEqual([])
  })
})

test.describe('Terminal links', () => {
  test.skip(!repoPath, 'Set SIMPLEEDIT_TEST_REPO to run IDE tests')

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

test.describe('Claude sessions', () => {
  test.skip(!repoPath, 'Set SIMPLEEDIT_TEST_REPO to run IDE tests')

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
      // The e2e fake claude exits on "/exit" input, so the exit-propagation
      // test below works without the real CLI.
      env: launchEnv({ SIMPLEEDIT_REPO: repo.bareRepoPath })
    })
    window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await waitForWorktreesReady(window)
  })

  test.afterEach(async () => {
    await app.close()
  })

  test('each ✦ Agent button click creates exactly one Claude PTY', async () => {
    const before: string[] = await window.evaluate(() => window.api.invoke('pty:active-ids'))
    const claudeBefore = before.filter((id) => id.startsWith('claude-'))

    await window.getByRole('button', { name: 'New agent session' }).first().click()
    await window.waitForTimeout(1000)

    const after: string[] = await window.evaluate(() => window.api.invoke('pty:active-ids'))
    const claudeAfter = after.filter((id) => id.startsWith('claude-'))

    expect(claudeAfter.length).toBe(claudeBefore.length + 1)
  })

  test('switching sessions does not collapse terminal columns to zero (#37)', async () => {
    // Two terminal sessions — switching between them hides one workspace and
    // shows the other, which is exactly the hidden-container ResizeObserver
    // case #37 was about.
    await spawnTerminalSession(window)
    await window.waitForTimeout(500)
    const secondTermId = await spawnTerminalSession(window)
    await window.waitForTimeout(500)

    const sessionOptions = window
      .getByRole('listbox', { name: 'Sessions' })
      .getByRole('option')
    await expect(sessionOptions).toHaveCount(2)

    // Rapid session switching to trigger ResizeObserver on hidden containers
    for (let i = 0; i < 3; i++) {
      await sessionOptions.nth(0).click()
      await window.waitForTimeout(200)
      await sessionOptions.nth(1).click()
      await window.waitForTimeout(200)
    }
    await window.waitForTimeout(500)

    // We're on the second terminal; ask its shell how wide it thinks it is.
    await window.evaluate(
      (id) => window.api.invoke('pty:write', id, 'tput cols\r'),
      secondTermId
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

  test('one session exiting naturally does not close the other', async () => {
    // Originally "/exit one of two Claude sessions". Which claude binary the
    // PTY's login shell resolves is environment-dependent (the real CLI shows
    // a trust prompt in fresh temp repos and ignores /exit), so exercise the
    // same invariant — one PTY's natural exit must only auto-close its own
    // session — with plain terminal sessions and a shell `exit`.
    await window.evaluate(() => {
      ;(window as any).__exitEvents = [] as string[]
      window.api.on('pty:exit', (payload) => {
        ;(window as any).__exitEvents.push(payload.id)
      })
    })

    const id1 = await spawnTerminalSession(window)
    const id2 = await spawnTerminalSession(window)

    await window.evaluate((id) => window.api.invoke('pty:write', id as string, ' exit\r'), id1)

    // The exited PTY disappears and its session auto-closes; the other lives.
    await expect
      .poll(
        async () =>
          (await window.evaluate(() => window.api.invoke('pty:active-ids'))) as string[],
        { timeout: 10_000 }
      )
      .not.toContain(id1)
    const activeAfter: string[] = await window.evaluate(() => window.api.invoke('pty:active-ids'))
    expect(activeAfter).toContain(id2)

    const exitEvents: string[] = await window.evaluate(() => (window as any).__exitEvents)
    expect(exitEvents).toContain(id1)
    expect(exitEvents).not.toContain(id2)
  })
})
