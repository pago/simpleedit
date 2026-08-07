import { test as base, expect } from '@playwright/test'
import { _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'
import os from 'os'
import { createHash } from 'crypto'
import { execSync } from 'child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
export const MAIN = path.join(ROOT, 'out/main/index.js')

// Chromium's sandbox requires kernel features unavailable in CI containers.
const SANDBOX_ARGS = process.env.CI ? ['--no-sandbox'] : []

// CI doesn't ship the real `claude` binary, so a Claude/Agent View PTY would
// exit immediately on `command not found`, the tab would auto-close via the
// pty:exit handler, and tests racing against Playwright's polling fail
// non-deterministically. Prepend a fake `claude` (e2e/bin) that just sleeps,
// keeping the PTY alive long enough for tab-strip assertions to land.
const E2E_BIN = path.join(__dirname, 'bin')
const PATH_KEY = process.platform === 'win32' ? 'Path' : 'PATH'
const PATH_SEP = process.platform === 'win32' ? ';' : ':'

/**
 * Build an env for `electron.launch` that prepends the e2e fake-binary
 * directory to PATH. Tests that need to spawn Claude PTYs should pass this
 * (merged with their own keys like SIMPLEEDIT_REPO) instead of `process.env`.
 */
export function launchEnv(extra: Record<string, string> = {}): Record<string, string> {
  const base = { ...process.env } as Record<string, string>
  base[PATH_KEY] = `${E2E_BIN}${PATH_SEP}${base[PATH_KEY] ?? ''}`
  // Render test windows without stealing OS focus (macOS accessory policy +
  // showInactive()), so a local test run isn't disruptive. Handled in main.
  base.SIMPLEEDIT_E2E = '1'
  if (extra.SIMPLEEDIT_REPO) {
    base.SIMPLEEDIT_E2E_MODEL_CONFIG = `${extra.SIMPLEEDIT_REPO}.models.json`
  }
  return { ...base, ...extra }
}

type AppFixtures = {
  app: ElectronApplication
  window: Page
}

/**
 * Wait until the renderer has loaded the worktree list. New sessions launch in
 * `worktreeList()[0]` (the Claude memory home), so the ✦ Agent / + Term spawn
 * buttons are DISABLED until that list arrives (commit eea4fab). The sidebar
 * no longer shows worktrees, so the enabled spawn button is the readiness
 * signal.
 */
export async function waitForWorktreesReady(window: Page): Promise<void> {
  await expect(
    window.getByRole('button', { name: 'New agent session' }).first()
  ).toBeEnabled({ timeout: 15_000 })
}

/**
 * Open the ACTIVE workspace's worktree popover via the header branch button
 * ("main ▾") and return the role="dialog" panel containing the WorktreeList
 * (listbox "Worktrees", Checkout / + New buttons, remove flow).
 *
 * Note: selecting or creating a worktree CLOSES the popover — reopen before
 * asserting on the list afterwards. A session must exist (the header lives in
 * SessionWorkspace).
 */
export async function openWorktreePopover(window: Page) {
  const trigger = window
    .getByTitle(/Worktree this workspace is pointed at/)
    .filter({ visible: true })
    .first()
  await expect(trigger).toBeVisible({ timeout: 10_000 })
  await trigger.click()
  const dialog = window
    .getByRole('dialog', { name: 'Worktrees' })
    .filter({ visible: true })
    .first()
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  return dialog
}

/** The branch label on the active workspace's worktree button ("main ▾" → "main"). */
export async function headerWorktreeBranch(window: Page): Promise<string> {
  const trigger = window
    .getByTitle(/Worktree this workspace is pointed at/)
    .filter({ visible: true })
    .first()
  const text = (await trigger.textContent()) ?? ''
  return text.replace(/▾/g, '').trim()
}

async function activePtyIds(window: Page): Promise<string[]> {
  return window.evaluate(() =>
    (window as unknown as { api: { invoke: (ch: string) => Promise<string[]> } }).api.invoke(
      'pty:active-ids'
    )
  )
}

/**
 * Spawn a session via a sidebar SessionList button and return its PTY id
 * (which doubles as the session id). The agent-first UI has no auto-spawned
 * terminal — every repo-gated test that needs a workspace creates one first.
 */
async function spawnSession(
  window: Page,
  button: 'claude' | 'terminal',
  idPrefix: RegExp
): Promise<string> {
  await waitForWorktreesReady(window)
  const before = new Set(await activePtyIds(window))
  if (button === 'claude') {
    await window.getByRole('button', { name: 'New agent session' }).first().click()
  } else {
    await window.getByTitle('New terminal').first().click()
  }
  await expect
    .poll(
      async () => (await activePtyIds(window)).find((id) => !before.has(id) && idPrefix.test(id)),
      { timeout: 10_000 }
    )
    .toBeDefined()
  const after = await activePtyIds(window)
  return after.find((id) => !before.has(id) && idPrefix.test(id))!
}

/** Spawn a Claude session via the ✦ Agent button; returns its provider-aware terminal id. */
export async function spawnClaudeSession(window: Page): Promise<string> {
  return spawnSession(window, 'claude', /^agent-claude-/)
}

/** Spawn a plain terminal session via the + Term button; returns the term- id. */
export async function spawnTerminalSession(window: Page): Promise<string> {
  return spawnSession(window, 'terminal', /^term-/)
}

/**
 * Open the active workspace's viewer (tab bar + file tree + git log) via the
 * "Files" toggle in the workspace header. A fresh session is a full-bleed
 * terminal — GitLog/FileTree only render after this.
 *
 * Locators are visible-filtered: WorkspaceManager keeps every visited
 * workspace mounted (hidden), so unscoped queries can resolve to a hidden
 * sibling workspace and trip Playwright's strict mode.
 */
export async function openWorkspaceViewer(window: Page): Promise<void> {
  const toggle = window
    .getByRole('button', { name: 'Files', exact: true })
    .filter({ visible: true })
    .first()
  await expect(toggle).toBeVisible({ timeout: 10_000 })
  await toggle.click()
  await expect(
    window.getByRole('listbox', { name: 'Commits' }).filter({ visible: true }).first()
  ).toBeVisible({ timeout: 10_000 })
}

/**
 * Delete the persisted session blob for a repo BEFORE launching the app.
 *
 * The app hydrates saved Claude sessions at startup as click-to-resume
 * placeholders; the previously-active one is auto-selected, which mounts a
 * (hidden) workspace complete with restored tabs, GitLog, header select etc.
 * Tests that auto-save sessions (any Claude-session spawn) therefore pollute
 * every later launch against the same repo — clear the file first.
 *
 * Mirrors main's session-store naming: sha1(repoPath) prefix under userData
 * (`Electron` for Playwright's unsigned build).
 */
export function clearSavedSessionFile(repoPath: string): void {
  const hash = createHash('sha1').update(repoPath).digest('hex').slice(0, 16)
  const file = path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'Electron',
    'config',
    'sessions',
    `${hash}.json`
  )
  try {
    fs.rmSync(file)
  } catch {
    /* not present */
  }
}

/** Locator for a session entry in the sidebar Sessions listbox. */
export function sessionOption(window: Page, label: string | RegExp) {
  return window
    .getByRole('listbox', { name: 'Sessions' })
    .getByRole('option', { name: label })
}

export interface TempRepo {
  root: string
  bareRepoPath: string
  mainWorktreePath: string
}

/**
 * Create a private bare repo + `main` worktree for one suite.
 *
 * The suite-shared SIMPLEEDIT_TEST_REPO cannot be used by suites that mutate
 * state: Playwright runs files in parallel workers against the same Electron
 * userData dir, so worktree lists and the per-repo session blob (auto-saved on
 * every Claude-session change, hydrated as placeholder sessions on the next
 * launch) race across workers. A per-suite repo removes the shared state.
 *
 * The bare path is realpath-resolved — on macOS /tmp is a symlink, and a
 * non-canonical SIMPLEEDIT_REPO makes worktree:create return paths that never
 * match `git worktree list` output (so e.g. auto-activation misses).
 *
 * Three commits + two files so diff/peek/pin scenarios have material.
 */
/**
 * Hermetic git env for fixture repos: ignore the host's global/system git
 * config. Without this, a host with commit signing enabled (SSH/GPG) makes
 * fixture commits prompt for a passphrase — which fails the entire suite the
 * moment the ssh-agent drops the key (e.g. after the machine locks).
 */
export const GIT_FIXTURE_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
}

export function createTempRepo(prefix: string): TempRepo {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const seed = path.join(root, 'seed')
  fs.mkdirSync(seed, { recursive: true })
  const sh = (cwd: string, cmd: string): void => {
    execSync(cmd, { cwd, stdio: 'pipe', env: GIT_FIXTURE_ENV })
  }
  sh(seed, 'git init --initial-branch=main')
  sh(seed, 'git config user.email test@example.com')
  sh(seed, 'git config user.name Test')
  fs.writeFileSync(path.join(seed, 'README.md'), '# seed\n')
  fs.mkdirSync(path.join(seed, 'src'), { recursive: true })
  fs.writeFileSync(path.join(seed, 'src', 'a.ts'), 'export const a = 1\n')
  sh(seed, 'git add .')
  sh(seed, 'git commit -m "initial"')
  fs.writeFileSync(path.join(seed, 'src', 'b.ts'), 'export const b = 2\n')
  sh(seed, 'git add .')
  sh(seed, 'git commit -m "second commit"')
  fs.writeFileSync(path.join(seed, 'src', 'c.ts'), 'export const c = 3\n')
  sh(seed, 'git add .')
  sh(seed, 'git commit -m "third commit"')

  const bare = path.join(root, 'repo.git')
  sh(root, `git clone --bare seed ${bare}`)
  sh(bare, 'git config remote.origin.fetch +refs/heads/*:refs/remotes/origin/*')
  const bareRepoPath = fs.realpathSync(bare)
  const mainWorktreePath = path.join(path.dirname(bareRepoPath), 'main')
  sh(bareRepoPath, `git worktree add ${mainWorktreePath} main`)
  return { root, bareRepoPath, mainWorktreePath }
}

/** Delete a temp repo created by createTempRepo (plus its session blob). */
export function removeTempRepo(repo: TempRepo | undefined): void {
  if (!repo) return
  clearSavedSessionFile(repo.bareRepoPath)
  try {
    fs.rmSync(repo.root, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
}

function assertBuilt(): void {
  if (!fs.existsSync(MAIN)) {
    throw new Error(
      `Built app not found at ${MAIN}\nRun "pnpm build" before running E2E tests.`
    )
  }
}

/** Launch the app without a repo — shows the Welcome screen. */
export const test = base.extend<AppFixtures>({
  app: async ({}, use) => {
    assertBuilt()
    const app = await electron.launch({ args: [MAIN, ...SANDBOX_ARGS], env: launchEnv() })
    await use(app)
    await app.close()
  },
  window: async ({ app }, use) => {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await use(page)
  }
})

/** Launch the app with a repo path — shows the IDE layout. */
export function makeRepoTest(repoPath: string) {
  return base.extend<AppFixtures>({
    app: async ({}, use) => {
      assertBuilt()
      const app = await electron.launch({
        args: [MAIN, ...SANDBOX_ARGS],
        env: launchEnv({ SIMPLEEDIT_REPO: repoPath })
      })
      await use(app)
      await app.close()
    },
    window: async ({ app }, use) => {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await use(page)
    }
  })
}

export { expect }
