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
import { MAIN } from './fixtures'

const SANDBOX_ARGS = process.env.CI ? ['--no-sandbox'] : []
const repoPath = process.env.SIMPLEEDIT_TEST_REPO
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

test.describe('Claude session_id capture', () => {
  test.skip(!repoPath, 'Set SIMPLEEDIT_TEST_REPO to run')

  let app: ElectronApplication
  let window: Page

  test.beforeEach(async () => {
    app = await electron.launch({
      args: [MAIN, ...SANDBOX_ARGS],
      env: { ...process.env, SIMPLEEDIT_REPO: repoPath! },
    })
    window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
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
      window.api.on('claude:session-id', (payload) => {
        ;(window as unknown as { __sessionIds: Array<{ terminalId: string; sessionId: string }> })
          .__sessionIds.push(payload)
      })
    })

    await window.getByTitle('Run Claude Code').first().click()

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
    expect(captured!.terminalId).toMatch(/^claude-/)
    expect(captured!.sessionId).toMatch(UUID_RE)
  })
})
