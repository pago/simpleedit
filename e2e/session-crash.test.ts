// A claude that dies at spawn must stay visible in the sessions inbox with
// its output readable: non-zero pty:exit keeps the entry (exited state)
// and the pty backlog replays output emitted before xterm attached.
import { _electron as electron } from '@playwright/test'
import { test, expect, MAIN, launchEnv, createTempRepo, removeTempRepo, waitForWorktreesReady } from './fixtures'

// CI's container can't use Chromium's sandbox (needs kernel features it lacks),
// so Electron won't launch there without --no-sandbox. Matches the sibling
// raw-launch suites.
const SANDBOX_ARGS = process.env.CI ? ['--no-sandbox'] : []

test('spawn-crash: session survives with banner and readable output', async () => {
  const repo = createTempRepo('crash-smoke')
  // Drive the fake claude into immediate non-zero exit (simulated spawn
  // failure). NB: don't nuke PATH to force "command not found" — a minimal
  // PATH also breaks Electron's own launch under CI's xvfb. Under E2E the app
  // spawns claude without a login shell, so the e2e fake (not a real claude on
  // the dev machine) deterministically runs and honours this env var.
  const app = await electron.launch({
    args: [MAIN, ...SANDBOX_ARGS],
    env: launchEnv({
      SIMPLEEDIT_REPO: repo.bareRepoPath,
      SIMPLEEDIT_FAKE_CLAUDE_EXIT: '127',
    }),
  })
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await waitForWorktreesReady(window)

  await window.getByRole('button', { name: 'New Claude session', exact: true }).click()

  // The session must NOT vanish: entry stays, marked exited.
  const entry = window.getByRole('listbox', { name: 'Sessions' }).getByRole('option').first()
  await expect(entry).toBeVisible()
  await expect(entry).toContainText('(exited)', { timeout: 10_000 })

  // Banner with the exit code… (xterm also renders its own "[Process exited]"
  // line, so match the banner's full phrasing)
  await expect(window.getByText(/Process exited with code \d+ — its last output is below/)).toBeVisible()
  // …and the crash output replayed into xterm despite the listener attaching late.
  await expect(
    window.locator('.xterm-rows').filter({ visible: true }).first()
  ).toContainText(/simulated spawn failure/i, { timeout: 5_000 })

  await app.close()
  removeTempRepo(repo)
})
