// A claude that dies at spawn must stay visible in the sessions inbox with
// its output readable: non-zero pty:exit keeps the entry (exited state)
// and the pty backlog replays output emitted before xterm attached.
import { _electron as electron } from '@playwright/test'
import { test, expect, MAIN, launchEnv, createTempRepo, removeTempRepo, waitForWorktreesReady } from './fixtures'

test('spawn-crash: session survives with banner and readable output', async () => {
  const repo = createTempRepo('crash-smoke')
  // /bin/sh as login shell in a bare HOME: `claude` is not on the default
  // PATH, so the spawn dies instantly with "not found" — same shape as the
  // dev-mode failure being debugged.
  const app = await electron.launch({
    args: [MAIN],
    env: launchEnv({
      SIMPLEEDIT_REPO: repo.bareRepoPath,
      SHELL: '/bin/sh',
      PATH: '/usr/bin:/bin',
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
  ).toContainText(/not found/i, { timeout: 5_000 })

  await window.screenshot({ path: '/tmp/smoke-crash.png' })
  await app.close()
  removeTempRepo(repo)
})
