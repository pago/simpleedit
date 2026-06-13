import { test, expect } from '@playwright/test'
import { _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execSync } from 'child_process'
import { MAIN, launchEnv, waitForWorktreesReady, GIT_FIXTURE_ENV } from './fixtures'

const SANDBOX_ARGS = process.env.CI ? ['--no-sandbox'] : []

/**
 * Issue #90 repro (ported to agent-first UI): right-clicking the new-Claude
 * (✦ Agent) button in the SessionList sidebar opens a context menu offering
 * "New Claude session" / "New Agent View session". Picking Agent View spawns a
 * session entry labelled "Agents" without attaching the stream-json parser.
 *
 * Stubbed expectations only: we don't actually launch `claude agents` (no
 * binary in CI). The test verifies:
 *   - left-click on ✦ Agent still creates a "Claude" session (unchanged)
 *   - right-click on ✦ Agent opens a menu with two role="menuitem" entries
 *   - selecting "New Agent View session" creates a session labelled "Agents"
 *   - the menu dismisses with Escape
 *   - an Agent View entry round-trips through session:save / session:load
 *
 * In the agent-first UI sessions live in the sidebar SessionList as
 * role="option" entries (was role="tab" in the old per-pane terminal strip),
 * and the spawn button's aria-label is "New Claude session" (was "Run Claude
 * Code").
 */
test.describe('Issue #90: Agent View context menu on new-Claude button', () => {
  let testRoot: string
  let bareRepoPath: string
  let app: ElectronApplication
  let window: Page

  // Fresh repo per test. These tests spawn Claude / Agent View tabs that the
  // app auto-saves; restore is now reliable (#28 fixed the mount-vs-hydrate
  // race), so a shared repo would leak persisted tabs across tests (a test
  // asserting "0 Agents tabs" would see a restored one). A unique repo per
  // test gives complete session isolation.
  test.beforeEach(async () => {
    testRoot = mkdtempSync(join(tmpdir(), 'simpleedit-issue90-'))

    const seedPath = join(testRoot, 'seed')
    mkdirSync(seedPath, { recursive: true })
    const sh = (cwd: string, cmd: string): void => {
      execSync(cmd, { cwd, stdio: 'pipe', env: GIT_FIXTURE_ENV })
    }
    sh(seedPath, 'git init --initial-branch=main')
    sh(seedPath, 'git config user.email test@example.com')
    sh(seedPath, 'git config user.name Test')
    writeFileSync(join(seedPath, 'README.md'), '# seed\n')
    sh(seedPath, 'git add README.md')
    sh(seedPath, 'git commit -m initial')

    bareRepoPath = join(testRoot, 'project.git')
    sh(testRoot, `git clone --bare ${seedPath} ${bareRepoPath}`)
    sh(bareRepoPath, 'git config remote.origin.fetch +refs/heads/*:refs/remotes/origin/*')
    sh(bareRepoPath, `git worktree add ${join(testRoot, 'main')} main`)

    app = await electron.launch({
      args: [MAIN, ...SANDBOX_ARGS],
      env: launchEnv({ SIMPLEEDIT_REPO: bareRepoPath })
    })
    window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await waitForWorktreesReady(window)
  })

  test.afterEach(async () => {
    await app.close()
    rmSync(testRoot, { recursive: true, force: true })
  })

  test('right-click opens menu; selecting Agent View spawns an Agents session', async () => {
    // The ✦ Agent button has aria-label="New Claude session".
    const claudeButton = window.getByRole('button', { name: 'New Claude session' }).first()
    await expect(claudeButton).toBeVisible({ timeout: 10_000 })

    // Right-click to open the context menu.
    await claudeButton.click({ button: 'right' })

    const menu = window.getByRole('menu').first()
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'New Claude session' })).toBeVisible()

    const agentItem = menu.getByRole('menuitem', { name: 'New Agent View session' })
    await expect(agentItem).toBeVisible()
    await agentItem.click()

    // Menu should dismiss.
    await expect(menu).not.toBeVisible()

    // A new session labelled "Agents" appears in the Sessions listbox.
    await expect(window.locator('[role="option"]:has-text("Agents")').first()).toBeVisible({ timeout: 5_000 })
  })

  test('left-click on ✦ Agent button still creates a Claude session (unchanged)', async () => {
    const claudeButton = window.getByRole('button', { name: 'New Claude session' }).first()
    await expect(claudeButton).toBeVisible({ timeout: 10_000 })
    await claudeButton.click()

    // The new Claude session is labelled "Claude" (no number on first one).
    await expect(window.locator('[role="option"]:has-text("Claude")').first()).toBeVisible({ timeout: 5_000 })
    // No menu should be open.
    await expect(window.getByRole('menu')).not.toBeVisible()
  })

  test('Escape dismisses the menu without picking', async () => {
    const claudeButton = window.getByRole('button', { name: 'New Claude session' }).first()
    await expect(claudeButton).toBeVisible({ timeout: 10_000 })
    await claudeButton.click({ button: 'right' })

    const menu = window.getByRole('menu').first()
    await expect(menu).toBeVisible()

    await window.keyboard.press('Escape')
    await expect(menu).not.toBeVisible()

    // No Agents session should have appeared.
    await expect(window.locator('[role="option"]:has-text("Agents")')).toHaveCount(0)
  })

  test('Agent View entries survive a session save/load round-trip', async () => {
    // Round-trip the SerializedSession (version 2) blob through the
    // session:save / session:load IPC handlers. An Agent View entry persists
    // with kind 'agents' and no sessionId, so on a real restart it respawns
    // fresh via claude:spawn-agents (not via a Resume placeholder).
    interface ApiOnly { api: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> } }

    const worktreePath = join(testRoot, 'main')
    const payload = {
      version: 2,
      repoPath: bareRepoPath,
      savedAt: new Date().toISOString(),
      sessions: [
        { kind: 'claude', label: 'Claude', sessionId: 'sid-1', worktreePath, tabs: [], activeTabId: null, unread: [] },
        { kind: 'agents', label: 'Agents', customLabel: true, worktreePath, tabs: [], activeTabId: null, unread: [] },
      ],
      activeIndex: 0,
    }

    await window.evaluate(
      async (p) => (window as unknown as ApiOnly).api.invoke('session:save', p),
      payload,
    )
    const loaded = (await window.evaluate(
      async (r) => (window as unknown as ApiOnly).api.invoke('session:load', r),
      bareRepoPath,
    )) as typeof payload | null

    expect(loaded).not.toBeNull()
    const sessions = loaded!.sessions
    expect(sessions).toHaveLength(2)

    const claude = sessions.find((s) => s.label === 'Claude')!
    expect(claude.kind).toBe('claude')
    expect(claude.sessionId).toBe('sid-1')

    const agents = sessions.find((s) => s.label === 'Agents')!
    expect(agents.kind).toBe('agents')
    expect(agents.sessionId).toBeUndefined()

    // Cleanup so subsequent runs aren't polluted.
    await window.evaluate(
      async (r) => (window as unknown as ApiOnly).api.invoke('session:clear', r),
      bareRepoPath,
    )
  })
})
