/**
 * Repro + regression guard for the "sibling repo never shows in the repo
 * picker" bug.
 *
 * A session starts in repo A. The agent READS or EDITS a file in repo B
 * without ever `cd`-ing there (Read/Edit/Write take an absolute path; they
 * don't move the process cwd). Before the fix the hook handler keyed the
 * session's repo trail purely off `cwd`, which stays in A — so B never joined
 * the repo dropdown. Now PostToolUse's `tool_input.file_path` is resolved to
 * its repo and recorded via `session:repo-touch`.
 *
 * This drives the REAL path end to end: a genuine PostToolUse hook POSTed to
 * the running window's bridge (port+token read from the spawn-time hook
 * settings file), through handleHook's repo discovery, the session:repo-touch
 * IPC, the renderer listener, and the RepoPicker menu. Like its e2e siblings
 * it's gated on SIMPLEEDIT_TEST_REPO so it runs locally, not in CI (CI coverage
 * lives in the deterministic cwd-tracker / mcp-bridge / session-trail tests).
 */
import { _electron as electron } from '@playwright/test'
import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import os from 'os'
import {
  MAIN,
  launchEnv,
  spawnClaudeSession,
  clearSavedSessionFile,
  createTempRepo,
  removeTempRepo,
  waitForWorktreesReady,
} from './fixtures'

const SANDBOX_ARGS = process.env.CI ? ['--no-sandbox'] : []
const repoPath = process.env.SIMPLEEDIT_TEST_REPO

test.describe('session repo trail — cross-repo file touch', () => {
  test.skip(!repoPath, 'Set SIMPLEEDIT_TEST_REPO to run')

  let app: ElectronApplication
  let window: Page
  let terminalId: string
  let sessionId: string

  // repoA is where the session lives; repoB is the sibling the agent only
  // reads/edits a file in.
  let repoA: ReturnType<typeof createTempRepo>
  let repoB: ReturnType<typeof createTempRepo>

  test.beforeAll(() => {
    repoA = createTempRepo('simpleedit-e2e-a-')
    repoB = createTempRepo('simpleedit-e2e-b-')
  })

  test.afterAll(() => {
    removeTempRepo(repoA)
    removeTempRepo(repoB)
  })

  test.beforeEach(async () => {
    clearSavedSessionFile(repoA.bareRepoPath)
    app = await electron.launch({
      args: [MAIN, ...SANDBOX_ARGS],
      env: launchEnv({ SIMPLEEDIT_REPO: repoA.bareRepoPath }),
    })
    window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await waitForWorktreesReady(window)

    // Capture the claude session_id (the uuid the hook body carries) — install
    // the listener BEFORE spawning, the event fires synchronously on spawn.
    await window.evaluate(() => {
      const w = window as unknown as {
        __sid?: string
        api: { on: (c: string, h: (p: { sessionId: string }) => void) => void }
      }
      w.__sid = undefined
      w.api.on('agent:session-id', (p) => {
        w.__sid = p.sessionId
      })
    })
    terminalId = await spawnClaudeSession(window)
    sessionId = await window.evaluate(async () => {
      const start = Date.now()
      while (Date.now() - start < 5_000) {
        const sid = (window as unknown as { __sid?: string }).__sid
        if (sid) return sid
        await new Promise((r) => setTimeout(r, 50))
      }
      throw new Error('claude:session-id never arrived')
    })
  })

  test.afterEach(async () => {
    await app.close()
  })

  /** The bridge /hooks URL, read from the settings file written at spawn. */
  async function hookUrl(): Promise<string> {
    const file = path.join(os.tmpdir(), `simpleedit-hooks-${terminalId}.json`)
    const start = Date.now()
    while (Date.now() - start < 5_000) {
      try {
        const settings = JSON.parse(fs.readFileSync(file, 'utf8'))
        const url = settings?.hooks?.PostToolUse?.[0]?.hooks?.[0]?.url
        if (typeof url === 'string') return url
      } catch {
        /* not written yet */
      }
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error(`hook settings file never appeared: ${file}`)
  }

  async function activeWorktree(): Promise<string> {
    return window.evaluate(() =>
      (window as unknown as { api: { invoke: (c: string) => Promise<Array<{ path: string }>> } })
        .api.invoke('worktree:list')
        .then((l) => l[0]?.path ?? ''),
    )
  }

  test('reading/editing a file in a sibling repo adds it to the repo picker', async () => {
    const url = await hookUrl()
    const cwdInA = await activeWorktree()
    const fileInB = path.join(repoB.mainWorktreePath, 'src', 'a.ts')

    // The repo button labels each repo by its temp-dir basename, so A and B are
    // distinguishable. Open the picker: only repo A is on the trail to start.
    const repoBtn = window
      .getByTitle(/Repository this workspace is viewing/)
      .filter({ visible: true })
      .first()
    await expect(repoBtn).toBeVisible({ timeout: 10_000 })

    const menu = window.getByRole('menu', { name: 'Repositories' }).filter({ visible: true }).first()
    const repoBItem = menu.getByRole('menuitem', { name: new RegExp(path.basename(repoB.root)) })

    await repoBtn.click()
    await expect(menu).toBeVisible()
    await expect(repoBItem).toHaveCount(0) // sibling not yet known
    await repoBtn.click() // close

    // Fire the real PostToolUse hook: cwd stays in A, the edited file is in B.
    const status = await window.evaluate(
      async ({ url, sessionId, cwdInA, fileInB }) => {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            session_id: sessionId,
            cwd: cwdInA,
            hook_event_name: 'PostToolUse',
            tool_name: 'Edit',
            tool_input: { file_path: fileInB, old_string: 'a', new_string: 'b' },
          }),
        })
        return res.status
      },
      { url, sessionId, cwdInA, fileInB },
    )
    expect(status).toBe(200)

    // Repo B now appears in the picker (the fix), and the active view stayed in
    // A — a file glance records the trail but never repoints the workspace.
    await repoBtn.click()
    await expect(menu).toBeVisible()
    await expect(repoBItem.first()).toBeVisible({ timeout: 10_000 })
  })
})
