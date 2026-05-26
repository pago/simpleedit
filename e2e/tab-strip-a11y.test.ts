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
 * Issue #97 regression — tab strip must not contain interactive descendants
 * of a `<button>` (HTML spec: a <button>'s content model is phrasing content
 * with no descendant interactive content). Before this fix the outer tab was
 * `<button>` and the ⋯ overflow + close `x` were `<span role="button" tabindex="0">`
 * inside it. Now the outer is `<div role="tab">` and the icon controls are
 * real `<button>` siblings — DOM-valid, screen-reader-friendly, and Enter/Space
 * on the icon controls is browser-native instead of hand-rolled in onkeydown.
 */
test.describe('Issue #97: tab strip a11y / DOM validity', () => {
  let testRoot: string
  let bareRepoPath: string
  let app: ElectronApplication
  let window: Page

  test.beforeAll(() => {
    testRoot = mkdtempSync(join(tmpdir(), 'simpleedit-issue97-'))

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

  test('Claude tab is role="tab" (not <button>), and ⋯ / close are real <button> children', async () => {
    // Spawn a Claude tab via the ✦ button so we have a Claude-kind tab with
    // its full set of inner controls (⋯ + x).
    const claudeButton = window.getByRole('button', { name: 'Run Claude Code' }).first()
    await expect(claudeButton).toBeVisible({ timeout: 10_000 })
    await claudeButton.click()

    const tab = window.locator('[role="tab"]:has-text("Claude")').first()
    await expect(tab).toBeVisible({ timeout: 5_000 })

    // The outer must be a <div role="tab">, not a <button>.
    const outerTag = await tab.evaluate((el) => el.tagName.toLowerCase())
    expect(outerTag).toBe('div')

    // No <button> may be the ancestor of another <button> in the tab strip
    // (the DOM-validity invariant #97 enforces).
    const nestedButtonCount = await window.evaluate(
      () => document.querySelectorAll('button button').length
    )
    expect(nestedButtonCount).toBe(0)

    // Hover to reveal the ⋯ button (opacity:0 group-hover:opacity-100).
    await tab.hover()
    const overflowBtn = tab.getByRole('button', { name: 'Tab options' })
    await expect(overflowBtn).toBeVisible({ timeout: 5_000 })
    const overflowTag = await overflowBtn.evaluate((el) => el.tagName.toLowerCase())
    expect(overflowTag).toBe('button')

    // Close button is a real <button> with aria-label.
    const closeBtn = tab.getByRole('button', { name: 'Close tab' })
    await expect(closeBtn).toBeVisible()
    const closeTag = await closeBtn.evaluate((el) => el.tagName.toLowerCase())
    expect(closeTag).toBe('button')
  })

  test('PromptModal dialog has tabindex="-1" so it can receive programmatic focus', async () => {
    // Spawn a Claude tab and open Rename… to surface the PromptModal.
    const claudeButton = window.getByRole('button', { name: 'Run Claude Code' }).first()
    await expect(claudeButton).toBeVisible({ timeout: 10_000 })
    await claudeButton.click()

    const tab = window.locator('[role="tab"]:has-text("Claude")').first()
    await tab.click({ button: 'right' })
    await window.getByRole('menuitem', { name: 'Rename…' }).click()

    const dialog = window.getByRole('dialog', { name: 'Rename tab' })
    await expect(dialog).toBeVisible()

    // Per Svelte's a11y_interactive_supports_focus: role="dialog" must have a
    // tabindex value so the dialog itself can receive focus when needed.
    const tabindex = await dialog.evaluate((el) => el.getAttribute('tabindex'))
    expect(tabindex).toBe('-1')
  })
})
