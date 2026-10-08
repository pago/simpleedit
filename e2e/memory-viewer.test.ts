/**
 * Claude memory viewer, end to end: a Claude session's repo picker opens the
 * project's auto-memory dir (resolved under a temp CLAUDE_CONFIG_DIR) in the
 * file tree, health problems show in the badge, a git-tracked memory dir gets
 * a scoped git log whose commits open as diffs, a deleted dir flips to the
 * empty state, and Back returns to the worktree.
 */
import { test, expect } from '@playwright/test'
import { _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execSync } from 'child_process'
import {
  MAIN,
  GIT_FIXTURE_ENV,
  launchEnv,
  spawnClaudeSession,
  openWorkspaceViewer,
  clearSavedSessionFile,
  createTempRepo,
  removeTempRepo,
  waitForWorktreesReady,
} from './fixtures'

const SANDBOX_ARGS = process.env.CI ? ['--no-sandbox'] : []

test.describe('Claude memory viewer', () => {
  let repo: ReturnType<typeof createTempRepo>
  let configDir: string
  let memoryDir: string
  let app: ElectronApplication
  let window: Page

  function seedMemory(): void {
    fs.mkdirSync(memoryDir, { recursive: true })
    fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), '# Memory\n\n- [Build notes](build-notes.md)\n')
    fs.writeFileSync(
      path.join(memoryDir, 'build-notes.md'),
      '---\nname: build-notes\n---\n\nUse pnpm. See [[ghost-note]] for details.\n',
    )
  }

  function sh(cwd: string, cmd: string): void {
    execSync(cmd, { cwd, stdio: 'pipe', env: GIT_FIXTURE_ENV })
  }

  test.beforeAll(() => {
    repo = createTempRepo('simpleedit-e2e-memory-')
    configDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'simpleedit-e2e-claude-config-')))
    // Sessions launch at the project root (beside the bare repo), which is not
    // a git work tree, so the CLI keys its memory by that directory.
    const projectRoot = path.dirname(repo.bareRepoPath)
    const key = projectRoot.replace(/[^A-Za-z0-9]/g, '-')
    memoryDir = path.join(configDir, 'projects', key, 'memory')
  })

  test.afterAll(() => {
    removeTempRepo(repo)
    fs.rmSync(configDir, { recursive: true, force: true })
  })

  test.beforeEach(async () => {
    fs.rmSync(memoryDir, { recursive: true, force: true })
    seedMemory()
    clearSavedSessionFile(repo.bareRepoPath)
    app = await electron.launch({
      args: [MAIN, ...SANDBOX_ARGS],
      env: launchEnv({ SIMPLEEDIT_REPO: repo.bareRepoPath, CLAUDE_CONFIG_DIR: configDir }),
    })
    window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await waitForWorktreesReady(window)
    await spawnClaudeSession(window)
    await openWorkspaceViewer(window)
  })

  test.afterEach(async () => {
    await app.close()
  })

  const visible = (page: Page) => ({
    repoPicker: () => page.getByTitle(/Repository this workspace is viewing/).filter({ visible: true }).first(),
    memoryItem: () => page.getByRole('menuitem', { name: 'Claude memory' }).filter({ visible: true }).first(),
    back: () => page.getByRole('button', { name: /^← Back to / }).filter({ visible: true }).first(),
    commits: () => page.getByRole('listbox', { name: 'Commits' }).filter({ visible: true }),
    healthCount: () => page.getByTestId('memory-health-count').filter({ visible: true }).first(),
    emptyState: () => page.getByTestId('memory-empty-state').filter({ visible: true }),
  })

  async function openMemory(page: Page): Promise<void> {
    const ui = visible(page)
    await ui.repoPicker().click()
    await ui.memoryItem().click()
    await expect(ui.back()).toBeVisible({ timeout: 10_000 })
  }

  test('shows the memory dir with its health and no git log, then goes back', async () => {
    const ui = visible(window)
    await openMemory(window)

    await expect(window.getByText('MEMORY.md').filter({ visible: true }).first()).toBeVisible()
    await expect(window.getByText('build-notes.md').filter({ visible: true }).first()).toBeVisible()
    // One seeded problem: the [[ghost-note]] link resolves to nothing.
    await expect(ui.healthCount()).toHaveText('1', { timeout: 10_000 })
    await expect(ui.commits()).toHaveCount(0)
    await expect(window.getByText('Memory health').filter({ visible: true }).first()).toBeVisible()

    await ui.back().click()
    await expect(ui.back()).toHaveCount(0)
    await expect(ui.repoPicker()).not.toHaveText(/Claude memory/)
    await expect(ui.commits().first()).toBeVisible()
  })

  test('a git-tracked memory dir gets a scoped log whose commits open as diffs', async () => {
    sh(memoryDir, 'git init --initial-branch=main')
    sh(memoryDir, 'git config user.email test@example.com')
    sh(memoryDir, 'git config user.name Test')
    sh(memoryDir, 'git add .')
    sh(memoryDir, 'git commit -m "remember build notes"')

    const ui = visible(window)
    await openMemory(window)

    const row = ui.commits().first().getByRole('option', { name: /remember build notes/ })
    await expect(row).toBeVisible({ timeout: 10_000 })
    await expect(window.getByTestId('gitlog-tour-icon').filter({ visible: true })).toHaveCount(0)

    await row.click()
    await expect(
      window.locator('[data-testid="worktree-tab"][data-kind="diff"][data-active="true"]').filter({ visible: true }),
    ).toHaveCount(1)
    // Review and tour would run over the whole enclosing repo, so a memory diff has neither.
    await expect(window.getByRole('button', { name: /✦ (Re-)?review/i }).filter({ visible: true })).toHaveCount(0)
  })

  test('a deleted memory dir flips to the empty state', async () => {
    const ui = visible(window)
    await openMemory(window)
    await expect(window.getByText('build-notes.md').filter({ visible: true }).first()).toBeVisible()

    fs.rmSync(memoryDir, { recursive: true, force: true })

    await expect(ui.emptyState()).toBeVisible({ timeout: 15_000 })
    await expect(ui.emptyState()).toContainText(memoryDir)
  })
})
