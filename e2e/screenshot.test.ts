/**
 * Screenshot script for marketing website.
 */
import { test } from '@playwright/test'
import { _electron as electron } from '@playwright/test'
import { MAIN } from './fixtures'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(__dirname, '../../..', 'simpleedit-website/main/public/screenshots')

const REPO = '/Users/patrick.gotthardt/Projects/open-source/simpleedit/simpleedit.git'

async function scrollToCommit(page: any, text: string): Promise<boolean> {
  for (let i = 0; i < 10; i++) {
    const el = page.locator(`aside button:has-text("${text}")`).first()
    if (await el.isVisible({ timeout: 300 }).catch(() => false)) return true
    await page.evaluate(() => {
      const list = document.querySelector('aside [role="listbox"]')
      if (list) list.scrollBy(0, 300)
    })
    await page.waitForTimeout(150)
  }
  return false
}

/** Start a Claude Code session in the first available terminal. */
async function startClaude(window: any): Promise<void> {
  const helpers = await window.locator('.xterm-helper-textarea').all()
  if (helpers.length > 0) {
    await helpers[0].focus()
    await window.keyboard.type('claude')
    await window.keyboard.press('Enter')
    await window.waitForTimeout(4000) // Let Claude print initial output
  }
}

test('welcome screen', async () => {
  const app = await electron.launch({ args: [MAIN] })
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await window.waitForTimeout(500)
  await window.screenshot({ path: path.join(OUT, 'welcome.png') })
  await app.close()
})

test('ide layout', async () => {
  const app = await electron.launch({
    args: [MAIN],
    env: { ...process.env, SIMPLEEDIT_REPO: REPO }
  })
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await window.waitForTimeout(1500)
  await startClaude(window)
  await window.screenshot({ path: path.join(OUT, 'ide.png') })
  await app.close()
})

test('diff review with findings', async () => {
  const app = await electron.launch({
    args: [MAIN],
    env: { ...process.env, SIMPLEEDIT_REPO: REPO }
  })
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await window.waitForTimeout(1500)

  // Start Claude in the terminal first so it's visible
  await startClaude(window)

  // Use a small single-file commit for fast review generation
  await scrollToCommit(window, 'feat: sanitize branch name')
  const commitBtn = window.locator('aside button:has-text("feat: sanitize branch name")').first()
  if (await commitBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
    await commitBtn.click()
  } else {
    const commits = await window.locator('aside [role="option"]').all()
    if (commits.length > 1) await commits[1].click()
  }
  await window.waitForTimeout(1500)

  // Click the "✦ Review" button in the top bar — triggers review and switches to Findings tab
  const mainBtns = await window.locator('main button').all()
  for (const btn of mainBtns) {
    const text = (await btn.innerText().catch(() => '')).trim()
    if (/review/i.test(text) && !/re-review/i.test(text)) {
      await btn.click()
      break
    }
  }

  // Wait for findings to stream in (single-file commit should be fast)
  await window.waitForTimeout(35000)

  await window.screenshot({ path: path.join(OUT, 'ide-review.png') })
  await app.close()
})

test('editor with autocomplete', async () => {
  const app = await electron.launch({
    args: [MAIN],
    env: { ...process.env, SIMPLEEDIT_REPO: REPO }
  })
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await window.waitForTimeout(1500)

  // Start Claude in the terminal
  await startClaude(window)

  // Navigate the file tree: find items by their text content inside span.truncate
  const treeItems = window.locator('[role="treeitem"]')

  // Step 1: Click 'src' folder
  const count = await treeItems.count()
  for (let i = 0; i < count; i++) {
    const item = treeItems.nth(i)
    const text = (await item.locator('span.truncate').textContent().catch(() => '')).trim()
    if (text === 'src') { await item.click(); await window.waitForTimeout(400); break }
  }

  // Step 2: Click 'main' subfolder
  const count2 = await treeItems.count()
  for (let i = 0; i < count2; i++) {
    const item = treeItems.nth(i)
    const text = (await item.locator('span.truncate').textContent().catch(() => '')).trim()
    if (text === 'main') { await item.click(); await window.waitForTimeout(400); break }
  }

  // Step 3: Click 'tour.ts'
  const count3 = await treeItems.count()
  for (let i = 0; i < count3; i++) {
    const item = treeItems.nth(i)
    const text = (await item.locator('span.truncate').textContent().catch(() => '')).trim()
    if (text === 'tour.ts') { await item.click(); await window.waitForTimeout(3000); break }
  }

  // Trigger autocomplete in Monaco
  const editor = window.locator('.monaco-editor').first()
  if (await editor.isVisible({ timeout: 2000 }).catch(() => false)) {
    await editor.click({ position: { x: 200, y: 150 } })
    await window.waitForTimeout(500)
    await window.keyboard.press('Control+Space')
    await window.waitForTimeout(2500)
  }

  await window.screenshot({ path: path.join(OUT, 'ide-editor.png') })
  await app.close()
})

test('diff with discuss with agent', async () => {
  const app = await electron.launch({
    args: [MAIN],
    env: { ...process.env, SIMPLEEDIT_REPO: REPO }
  })
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await window.waitForTimeout(1500)

  // Start Claude so it appears as an option in the Discuss with Agent terminal selector
  await startClaude(window)

  // Scroll git log to find the AI tour feature commit
  await scrollToCommit(window, 'feat: add AI-powered')
  const commitBtn = window.locator('aside button:has-text("feat: add AI-powered")').first()
  if (await commitBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
    await commitBtn.click()
  } else {
    const commits = await window.locator('aside [role="option"]').all()
    if (commits.length > 1) await commits[1].click()
  }
  await window.waitForTimeout(1500)

  // Click on src/main/tour.ts to open a nice code file in the diff
  const fileBtn = window.locator('main button[title="src/main/tour.ts"]')
  if (await fileBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await fileBtn.click()
    await window.waitForTimeout(2500)
  }

  // Focus Monaco and trigger Discuss with Agent (Cmd+I on Mac)
  const monacoEditors = await window.locator('.monaco-editor').all()
  if (monacoEditors.length > 0) {
    const lastEditor = monacoEditors[monacoEditors.length - 1]
    await lastEditor.click({ position: { x: 200, y: 120 } })
    await window.waitForTimeout(300)
    await window.keyboard.press('Home')
    await window.keyboard.press('Shift+End')
    await window.waitForTimeout(200)
    await window.keyboard.press('Meta+i')
    await window.waitForTimeout(1000)
  }

  await window.screenshot({ path: path.join(OUT, 'ide-discuss.png') })
  await app.close()
})

test('diff with tour', async () => {
  const app = await electron.launch({
    args: [MAIN],
    env: { ...process.env, SIMPLEEDIT_REPO: REPO }
  })
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await window.waitForTimeout(1500)

  // Scroll to the AI tour feature commit
  await scrollToCommit(window, 'feat: add AI-powered')
  const commitBtn = window.locator('aside button:has-text("feat: add AI-powered")').first()
  if (await commitBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
    await commitBtn.click()
  } else {
    const commits = await window.locator('aside [role="option"]').all()
    if (commits.length > 1) await commits[1].click()
  }
  await window.waitForTimeout(1500)

  // Click the Tour tab
  const mainBtns = await window.locator('main button').all()
  for (const btn of mainBtns) {
    const text = await btn.innerText().catch(() => '')
    const trimmed = text.trim().toUpperCase()
    if (/^TOUR(\s+\(\d+\))?$/.test(trimmed)) {
      await btn.click()
      break
    }
  }
  await window.waitForTimeout(1000)

  // If no tour is cached, generate it
  const generateBtn = window.locator('button:has-text("Generate Tour")')
  if (await generateBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
    await generateBtn.click()
    await window.waitForSelector('main [class*="tour"] h2, main h3, main p', { timeout: 60000 }).catch(() => {})
    await window.waitForTimeout(25000)
  }

  // Start Claude in the terminal now that the tour content is loaded
  await startClaude(window)

  await window.screenshot({ path: path.join(OUT, 'ide-tour.png') })
  await app.close()
})
