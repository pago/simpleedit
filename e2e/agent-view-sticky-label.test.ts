import { test, expect } from '@playwright/test'
import { _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execSync } from 'child_process'
import { MAIN, launchEnv } from './fixtures'

const SANDBOX_ARGS = process.env.CI ? ['--no-sandbox'] : []

/**
 * Issue #94 regression — Agent View tab labels ("Agents", "Agents 2", …) must
 * survive an OSC title-set event from the `claude agents` TUI. The fix marks
 * Agent View tabs `customLabel: true` at construction so handleTitleChange
 * early-returns instead of overwriting the friendly label with whatever the
 * TUI puts in the xterm window title.
 */
test.describe('Issue #94: Agent View tab labels stay sticky under OSC title overwrite', () => {
  let testRoot: string
  let bareRepoPath: string
  let app: ElectronApplication
  let window: Page

  test.beforeAll(() => {
    testRoot = mkdtempSync(join(tmpdir(), 'simpleedit-issue94-'))

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
      env: launchEnv({ SIMPLEEDIT_REPO: bareRepoPath })
    })
    window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
  })

  test.afterEach(async () => {
    await app.close()
  })

  test('Agent View tab label is not overwritten by an OSC title-set sequence', async () => {
    // Capture all pty:data ids so we can find the Agent View tab's terminal id
    // (it's a runtime-generated string we can't predict).
    await window.evaluate(() => {
      ;(window as unknown as { __ptyIds: string[] }).__ptyIds = []
      window.api.on('pty:data', (payload) => {
        const ids = (window as unknown as { __ptyIds: string[] }).__ptyIds
        if (payload.id.startsWith('agents-') && !ids.includes(payload.id)) {
          ids.push(payload.id)
        }
      })
    })

    // Spawn an Agent View tab via the context menu.
    const claudeButton = window.getByRole('button', { name: 'Run Claude Code' }).first()
    await expect(claudeButton).toBeVisible({ timeout: 10_000 })
    await claudeButton.click({ button: 'right' })
    await window.getByRole('menuitem', { name: 'New Agent View session' }).click()

    // Tab labeled "Agents" appears.
    const agentsTab = window.locator('button:has-text("Agents")').first()
    await expect(agentsTab).toBeVisible({ timeout: 5_000 })

    // Wait until pty:data has been observed at least once — that tells us the
    // PTY is running and an xterm listener is wired up for our Agent View tab.
    const terminalId = (await window.waitForFunction(
      () => {
        const ids = (window as unknown as { __ptyIds: string[] }).__ptyIds
        return ids.length > 0 ? ids[0] : null
      },
      undefined,
      { timeout: 10_000 }
    )) as unknown as { jsonValue: () => Promise<string> }
    const idValue = await terminalId.jsonValue()
    expect(idValue).toMatch(/^agents-/)

    // Inject an OSC title-set sequence (ESC ] 0 ; … BEL). xterm parses the
    // sequence and fires onTitleChange, which dispatches to handleTitleChange.
    // Pre-fix, the tab label would be overwritten by "claude agents — pretty
    // overwrite"; with customLabel:true set at construction, the early-return
    // in handleTitleChange keeps "Agents" sticky.
    await app.evaluate(
      ({ BrowserWindow }, { id, data }) => {
        const wc = BrowserWindow.getAllWindows()[0].webContents
        wc.send('pty:data', { id, data })
      },
      { id: idValue, data: '\x1b]0;claude agents — pretty overwrite\x07' }
    )

    // Give xterm a beat to parse the OSC and dispatch the title event.
    await window.waitForTimeout(150)

    // Label is still "Agents" — not "claude agents — pretty overwrite". The
    // tab's button text contains decorative glyphs (✦ before, ⋯ × after);
    // check the button's `title` attribute which mirrors the label exactly,
    // and assert the overwrite string never landed anywhere.
    await expect(agentsTab).toBeVisible()
    await expect(agentsTab).toHaveAttribute('title', 'Agents')
    await expect(
      window.locator('button:has-text("claude agents — pretty overwrite")')
    ).toHaveCount(0)
  })
})
