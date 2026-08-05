/**
 * E2E coverage for the session save/restore feature.
 *
 * Two scenarios:
 *   1. Round-trip the SerializedSession blob through the session:save and
 *      session:load IPC handlers in a real Electron app — covers the file
 *      I/O path end-to-end including userData scoping.
 *   2. Open a file via the file tree, kill the app, relaunch, and assert the
 *      tab is restored — exercises the renderer hydrate path.
 */
import { test as base, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { MAIN, launchEnv, spawnClaudeSession, openWorkspaceViewer, clearSavedSessionFile, createTempRepo, removeTempRepo } from './fixtures'

const SANDBOX_ARGS = process.env.CI ? ['--no-sandbox'] : []
const repoPath = process.env.SIMPLEEDIT_TEST_REPO

interface ApiOnly { api: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> } }

async function launch(env: Record<string, string> = {}): Promise<{ app: ElectronApplication; window: Page }> {
  const app = await electron.launch({
    args: [MAIN, ...SANDBOX_ARGS],
    env: launchEnv(env)
  })
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  return { app, window }
}

base.describe('session save/restore — IPC round-trip', () => {
  let app: ElectronApplication
  let window: Page

  base.beforeEach(async () => {
    const launched = await launch()
    app = launched.app
    window = launched.window
  })

  base.afterEach(async () => {
    await app.close()
  })

  base('session:save then session:load returns the same payload', async () => {
    const repo = `/tmp/session-roundtrip-${Date.now()}.git`
    const payload = {
      version: 2,
      repoPath: repo,
      savedAt: new Date().toISOString(),
      sessions: [
        {
          kind: 'claude',
          label: 'Claude',
          sessionId: 'roundtrip-sid',
          worktreePath: '/tmp/session-roundtrip-wt',
          tabs: [
            { kind: 'file', id: 'file:/tmp/foo.ts', path: '/tmp/foo.ts' }
          ],
          activeTabId: 'file:/tmp/foo.ts',
          unread: []
        }
      ],
      activeIndex: 0
    }

    await window.evaluate(
      async (p) => (window as unknown as ApiOnly).api.invoke('session:save', p),
      payload
    )
    const loaded = await window.evaluate(
      async (r) => (window as unknown as ApiOnly).api.invoke('session:load', r),
      repo
    )
    expect(loaded).toEqual({
      ...payload,
      version: 4,
      sessions: payload.sessions.map((session) => ({
        ...session,
        kind: 'agent',
        provider: 'claude',
        target: { provider: 'claude' },
      })),
    })

    // Cleanup so subsequent runs aren't polluted.
    await window.evaluate(
      async (r) => (window as unknown as ApiOnly).api.invoke('session:clear', r),
      repo
    )
    const cleared = await window.evaluate(
      async (r) => (window as unknown as ApiOnly).api.invoke('session:load', r),
      repo
    )
    expect(cleared).toBeNull()
  })
})

base.describe('session save/restore — file tab survives relaunch', () => {
  base.skip(!repoPath, 'Set SIMPLEEDIT_TEST_REPO to run the relaunch scenario')

  base('opening a file then relaunching restores the tab', async () => {
    // Private repo: the per-repo session blob must survive between the two
    // launches below, and parallel suites clearing/writing the shared repo's
    // blob would race us.
    const repo = createTempRepo('simpleedit-restore-')

    // First launch — spawn a Claude session (only claude/agents sessions are
    // persisted; plain terminals are not), open its workspace viewer, and open
    // a file via the file tree.
    let { app, window } = await launch({ SIMPLEEDIT_REPO: repo.bareRepoPath })

    await spawnClaudeSession(window)
    await openWorkspaceViewer(window)

    // Click the first *file* (not directory) in the file tree to open a tab.
    const fileNode = window.locator('[role="treeitem"]:not([aria-expanded]):visible').first()
    await expect(fileNode).toBeVisible({ timeout: 10_000 })
    // The treeitem text includes the file-type glyph ("📄 README.md") — the
    // file NAME is the last whitespace-separated token.
    const fileLabel = (await fileNode.textContent())?.trim().split(/\s+/).pop()
    await fileNode.click()
    // The file tab must actually open before the save below can include it.
    await expect(
      window.locator('[data-testid="worktree-tab"][data-kind="file"]').first()
    ).toBeVisible({ timeout: 5_000 })
    await window.waitForTimeout(1_200) // let debounced save fire (500ms)

    await app.close()

    // Second launch — same repo. The session should come back as a
    // click-to-resume placeholder in the Sessions list…
    const second = await launch({ SIMPLEEDIT_REPO: repo.bareRepoPath })
    app = second.app
    window = second.window
    await expect(
      window
        .getByRole('listbox', { name: 'Sessions' })
        .getByRole('option')
        .first()
    ).toBeVisible({ timeout: 10_000 })

    // …and the saved blob must contain the file tab for the hydrate path.
    const loaded = (await window.evaluate(
      async (r) => (window as unknown as ApiOnly).api.invoke('session:load', r),
      repo.bareRepoPath
    )) as { sessions: Array<{ tabs: Array<{ kind: string; path?: string }> }> } | null

    expect(loaded).not.toBeNull()
    const allTabs = loaded!.sessions.flatMap((s) => s.tabs)
    const fileTabs = allTabs.filter((t) => t.kind === 'file')
    expect(fileTabs.length).toBeGreaterThan(0)
    if (fileLabel) {
      expect(fileTabs.some((t) => (t.path ?? '').endsWith(fileLabel))).toBe(true)
    }

    await app.close()
    removeTempRepo(repo)
  })
})
