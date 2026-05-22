import { test, expect } from '@playwright/test'
import { _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execSync } from 'child_process'
import { MAIN } from './fixtures'

const SANDBOX_ARGS = process.env.CI ? ['--no-sandbox'] : []

/**
 * Issue #90 repro: right-clicking the new-Claude (✦) button in the terminal
 * tab strip opens a context menu offering "New Claude session" / "New Agent
 * View session". Picking Agent View spawns a tab labelled "Agents" without
 * attaching the stream-json parser.
 *
 * Stubbed expectations only: we don't actually launch `claude agents` (no
 * binary in CI). The test verifies:
 *   - left-click on ✦ still creates a "Claude" tab (unchanged behaviour)
 *   - right-click on ✦ opens a menu with two role="menuitem" entries
 *   - selecting "New Agent View session" creates a tab labelled "Agents"
 *   - the menu dismisses with Escape
 *   - the isAgentView flag round-trips through session:save / session:load
 */
test.describe('Issue #90: Agent View context menu on new-Claude button', () => {
  let testRoot: string
  let bareRepoPath: string
  let app: ElectronApplication
  let window: Page

  test.beforeAll(() => {
    testRoot = mkdtempSync(join(tmpdir(), 'simpleedit-issue90-'))

    const seedPath = join(testRoot, 'seed')
    mkdirSync(seedPath, { recursive: true })
    const sh = (cwd: string, cmd: string): void => {
      execSync(cmd, { cwd, stdio: 'pipe' })
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
  })

  test.afterAll(() => {
    rmSync(testRoot, { recursive: true, force: true })
  })

  test.beforeEach(async () => {
    app = await electron.launch({
      args: [MAIN, ...SANDBOX_ARGS],
      env: { ...process.env, SIMPLEEDIT_REPO: bareRepoPath }
    })
    window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
  })

  test.afterEach(async () => {
    await app.close()
  })

  test('right-click opens menu; selecting Agent View spawns an Agents tab', async () => {
    // The ✦ button has aria-label="Run Claude Code".
    const claudeButton = window.getByRole('button', { name: 'Run Claude Code' }).first()
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

    // A new tab labelled "Agents" appears in the tab strip.
    // The tab button title is the label (per TerminalTabs.svelte). Use a tab
    // button with the visible "Agents" text.
    await expect(window.locator('button:has-text("Agents")').first()).toBeVisible({ timeout: 5_000 })
  })

  test('left-click on ✦ button still creates a Claude tab (unchanged)', async () => {
    const claudeButton = window.getByRole('button', { name: 'Run Claude Code' }).first()
    await expect(claudeButton).toBeVisible({ timeout: 10_000 })
    await claudeButton.click()

    // The new Claude tab is labelled "Claude" (no number on first one).
    await expect(window.locator('button:has-text("Claude")').first()).toBeVisible({ timeout: 5_000 })
    // No menu should be open.
    await expect(window.getByRole('menu')).not.toBeVisible()
  })

  test('Escape dismisses the menu without picking', async () => {
    const claudeButton = window.getByRole('button', { name: 'Run Claude Code' }).first()
    await expect(claudeButton).toBeVisible({ timeout: 10_000 })
    await claudeButton.click({ button: 'right' })

    const menu = window.getByRole('menu').first()
    await expect(menu).toBeVisible()

    await window.keyboard.press('Escape')
    await expect(menu).not.toBeVisible()

    // No Agents tab should have appeared.
    await expect(window.locator('button:has-text("Agents")')).toHaveCount(0)
  })

  test('Agent View tabs survive a session save/load round-trip', async () => {
    // Round-trip the SerializedSession blob through the session:save /
    // session:load IPC handlers. The isAgentView flag must be preserved so
    // that on a real restart, TerminalTabs respawns the tab via
    // claude:spawn-agents (not via Resume placeholder).
    interface ApiOnly { api: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> } }

    const worktreePath = join(testRoot, 'main')
    const payload = {
      version: 1,
      repoPath: bareRepoPath,
      savedAt: new Date().toISOString(),
      layout: {
        primaryWorktreePath: worktreePath,
        secondaryWorktreePath: null,
        focusedPane: 'primary' as const,
        splitRatio: 50,
        visitedPrimary: [worktreePath],
        visitedSecondary: [],
      },
      worktreeStates: [
        {
          worktreePath,
          tabs: [],
          activeTabId: null,
          mru: [],
          unread: [],
          primaryClaudeSessions: [
            { label: 'Claude', sessionId: 'sid-1' },
            { label: 'Agents', isAgentView: true },
          ],
          secondaryClaudeSessions: [],
        },
      ],
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
    const sessions = loaded!.worktreeStates[0].primaryClaudeSessions
    expect(sessions).toHaveLength(2)

    const claude = sessions.find((s) => s.label === 'Claude')!
    expect(claude.sessionId).toBe('sid-1')
    expect(claude.isAgentView).toBeUndefined()

    const agents = sessions.find((s) => s.label === 'Agents')!
    expect(agents.isAgentView).toBe(true)
    expect(agents.sessionId).toBeUndefined()

    // Cleanup so subsequent runs aren't polluted.
    await window.evaluate(
      async (r) => (window as unknown as ApiOnly).api.invoke('session:clear', r),
      bareRepoPath,
    )
  })
})
