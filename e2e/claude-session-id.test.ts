/**
 * Verifies that fresh Claude tabs get a session_id captured immediately on
 * spawn (no waiting for the user's first message).
 *
 * Mechanism (see pty.ts:spawnClaudeTerminal): we mint a UUID up front, pass
 * it to claude as `--session-id`, and emit `claude:session-id` synchronously
 * after `pty.spawn`. Replaces the broken stream-json-based capture in
 * claude-stream.ts which is a no-op under a TTY on CLI 2.1.148+.
 *
 * No `claude` binary is required for this test — we don't wait for the CLI
 * to actually start, just for the IPC event the main process emits the
 * moment the PTY is spawned.
 */
import { _electron as electron } from '@playwright/test'
import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { MAIN, waitForWorktreesReady, clearSavedSessionFile, createTempRepo, removeTempRepo, launchEnv } from './fixtures'

const SANDBOX_ARGS = process.env.CI ? ['--no-sandbox'] : []
const repoPath = process.env.SIMPLEEDIT_TEST_REPO
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

test.describe('Claude session_id capture', () => {
  test.skip(!repoPath, 'Set SIMPLEEDIT_TEST_REPO to run')

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
      // The e2e fake claude emits the real CLI's idle OSC title when
      // SIMPLEEDIT_FAKE_CLAUDE_OSC=1, exercising the OSC→claude:status
      // pipeline deterministically (the real CLI's title behaviour depends
      // on per-folder trust state, which a fresh temp repo never has).
      env: launchEnv({ SIMPLEEDIT_REPO: repo.bareRepoPath, SIMPLEEDIT_FAKE_CLAUDE_OSC: '1' }),
    })
    window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await waitForWorktreesReady(window)
  })

  test.afterEach(async () => {
    await app.close()
  })

  test('claude:session-id fires immediately on spawning a fresh Claude tab', async () => {
    // Install the IPC listener BEFORE clicking the spawn button, because the
    // main process emits the event right after `pty.spawn` returns.
    await window.evaluate(() => {
      ;(window as unknown as { __sessionIds: Array<{ terminalId: string; sessionId: string }> })
        .__sessionIds = []
      window.api.on('agent:session-id', (payload) => {
        ;(window as unknown as { __sessionIds: Array<{ terminalId: string; sessionId: string }> })
          .__sessionIds.push(payload)
      })
    })

    await window.getByRole('button', { name: 'New agent session' }).first().click()

    // Should arrive synchronously (within 1s, just absorbing IPC roundtrip).
    const captured = await window.evaluate(async () => {
      const start = Date.now()
      while (Date.now() - start < 5_000) {
        const arr = (window as unknown as { __sessionIds: Array<{ terminalId: string; sessionId: string }> })
          .__sessionIds
        if (arr.length > 0) return arr[0]
        await new Promise((r) => setTimeout(r, 50))
      }
      return null
    })

    expect(captured, 'claude:session-id was not emitted on spawn').not.toBeNull()
    expect(captured!.terminalId).toMatch(/^agent-claude-/)
    expect(captured!.sessionId).toMatch(UUID_RE)
  })

  // End-to-end coverage of the OSC-title → claude:status path that drives the
  // worktree-sidebar's Claude activity badge. Unit tests in
  // claude-stream.test.ts only exercise the OSC parser + status mapper in
  // isolation — they don't cover the spawn→onData→IPC→renderer wiring.
  //
  // TODO: skipped — which `claude` the PTY runs is environment-dependent. The
  // PTY spawns a login shell whose profile re-prepends the user's real bin dir,
  // shadowing the e2e fake (which emits a deterministic idle OSC via
  // SIMPLEEDIT_FAKE_CLAUDE_OSC=1). The real CLI in a fresh, untrusted temp repo
  // sits in its trust prompt and never emits a marker title, so the event never
  // arrives. Re-enable once the PTY spawn pins PATH past the profile (or the
  // suite pre-trusts the temp dir).
  test.skip('claude:status badge events flow after a Claude tab is spawned', async () => {
    await window.evaluate(() => {
      ;(window as unknown as { __statusEvents: Array<{ worktreePath: string; status: string; terminalId: string }> })
        .__statusEvents = []
      window.api.on('agent:status', (payload) => {
        ;(window as unknown as { __statusEvents: Array<{ worktreePath: string; status: string; terminalId: string }> })
          .__statusEvents.push(payload)
      })
    })

    await window.getByRole('button', { name: 'New agent session' }).first().click()

    // Claude emits OSC title sequences ("✳ Claude Code" idle, braille spinner
    // running) as soon as the TUI starts rendering — typically within 1–2s of
    // spawn on a warm box. 15s gives generous headroom for cold-start.
    const status = await window.evaluate(async () => {
      const start = Date.now()
      while (Date.now() - start < 15_000) {
        const arr = (window as unknown as { __statusEvents: Array<{ worktreePath: string; status: string; terminalId: string }> })
          .__statusEvents
        if (arr.length > 0) return arr[0]
        await new Promise((r) => setTimeout(r, 100))
      }
      return null
    })

    expect(status, 'no claude:status event arrived within 15s — OSC parser path may be broken').not.toBeNull()
    expect(status!.terminalId).toMatch(/^agent-claude-/)
    expect(['idle', 'running']).toContain(status!.status)
  })
})
