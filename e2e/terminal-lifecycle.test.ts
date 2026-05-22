/**
 * Regression guards for the Terminal/PTY lifecycle.
 *
 * Origin story (#88): users reported that long-running terminal work — tmux
 * sessions, Claude agent teams, anything with a continuously-attached PTY —
 * vanished when the pane's worktree was switched away and back. The PTY in
 * main was alive; the xterm renderer in the visible pane was blank.
 *
 * Root cause: `TerminalTabs.svelte` minted ids as `term-${Date.now()}-${nextIndex}`.
 * When PaneManager mounted several WorktreePanes at the same tick (e.g.
 * session-restore replaying a multi-pane layout), every TerminalTabs's
 * auto-created tab took the same Date.now() ms and started with nextIndex=1,
 * colliding on a single id. Two or more Terminal components then attached
 * `pty:data` listeners to the same PTY, wedging the xterm renderers.
 *
 * Fix: mint ids with `crypto.randomUUID()`. The regression guard here checks
 * `window.__simpleeditTerminalLifecycle__`, instrumented in `Terminal.svelte`,
 * which records one event per setup/cleanup. Any terminalId with more than one
 * `setup` event means two components attached to the same id — i.e. the bug
 * is back.
 */
import { _electron as electron } from '@playwright/test'
import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { MAIN } from './fixtures'
import { createHash } from 'crypto'
import { rmSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const SANDBOX_ARGS = process.env.CI ? ['--no-sandbox'] : []
const repoPath = process.env.SIMPLEEDIT_TEST_REPO

interface LifecycleEvent {
  event: 'setup' | 'cleanup'
  id: string
  t: number
}

function clearSavedSession(repo: string): void {
  const hash = createHash('sha1').update(repo).digest('hex').slice(0, 16)
  const file = join(homedir(), 'Library', 'Application Support', 'Electron', 'config', 'sessions', `${hash}.json`)
  try { rmSync(file) } catch { /* not present */ }
}

async function readLifecycle(window: Page): Promise<LifecycleEvent[]> {
  return await window.evaluate(
    () =>
      (window as unknown as { __simpleeditTerminalLifecycle__?: LifecycleEvent[] })
        .__simpleeditTerminalLifecycle__ ?? [],
  )
}

async function readTerminalText(window: Page): Promise<string> {
  return await window.evaluate(() => {
    const rows = document.querySelectorAll('.xterm-rows > div')
    return Array.from(rows).map((d) => d.textContent ?? '').join('\n')
  })
}

async function waitFor(
  window: Page,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true
    await window.waitForTimeout(80)
  }
  return false
}

/**
 * The core regression guard. Every Terminal instance should have exactly one
 * `setup` event. More than one means two components attached to the same PTY
 * id — the #88 bug.
 */
async function assertNoTerminalIdCollisions(window: Page): Promise<void> {
  const events = await readLifecycle(window)
  const setupsPerTerm = new Map<string, number>()
  for (const e of events) {
    if (e.event !== 'setup') continue
    setupsPerTerm.set(e.id, (setupsPerTerm.get(e.id) ?? 0) + 1)
  }
  for (const [id, count] of setupsPerTerm) {
    expect(count, `terminal ${id} was set up ${count} times — multiple components on one PTY (#88)`).toBe(1)
  }
}

test.describe('Terminal/PTY lifecycle', () => {
  test.skip(!repoPath, 'Set SIMPLEEDIT_TEST_REPO to run')

  let app: ElectronApplication
  let window: Page

  /**
   * The #88 repro requires a saved session whose `visitedPrimary` list has
   * ≥2 paths, so PaneManager mounts ≥2 WorktreePanes at the same tick. We
   * seed that by visiting several worktrees in a warmup launch and waiting
   * for the debounced save to flush before relaunching.
   */
  async function launch(opts: { clearSession?: boolean; seedVisited?: number } = {}): Promise<void> {
    if (opts.clearSession) clearSavedSession(repoPath!)
    if (opts.seedVisited && opts.seedVisited > 0) {
      const warmup = await electron.launch({
        args: [MAIN, ...SANDBOX_ARGS],
        env: { ...process.env, SIMPLEEDIT_REPO: repoPath! },
      })
      const w = await warmup.firstWindow()
      await w.waitForLoadState('domcontentloaded')
      const wtOptions = w.getByRole('listbox', { name: 'Worktrees' }).getByRole('option')
      await expect.poll(async () => await wtOptions.count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(opts.seedVisited)
      for (let i = 0; i < opts.seedVisited; i++) {
        await wtOptions.nth(i).click()
        await w.waitForTimeout(150)
      }
      // Wait long enough for the debounced session save (500ms) to flush.
      await w.waitForTimeout(1_500)
      await warmup.close()
    }
    app = await electron.launch({
      args: [MAIN, ...SANDBOX_ARGS],
      env: { ...process.env, SIMPLEEDIT_REPO: repoPath! },
    })
    window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await window.evaluate(() => {
      ;(window as unknown as { __simpleeditTerminalLifecycle__: unknown[] }).__simpleeditTerminalLifecycle__ = []
    })
  }

  test.beforeEach(async () => {
    await launch({ clearSession: true })
  })

  test.afterEach(async () => {
    await app.close()
  })

  async function waitForDefaultTerm(): Promise<string> {
    const listbox = window.getByRole('listbox', { name: 'Worktrees' })
    await expect(listbox).toBeVisible({ timeout: 10_000 })
    const options = listbox.getByRole('option')
    await expect.poll(async () => await options.count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(2)
    await expect
      .poll(
        async () => await window.evaluate(() => window.api.invoke('pty:active-ids')),
        { timeout: 10_000 },
      )
      .toEqual(expect.arrayContaining([expect.stringMatching(/^term-/)]))
    const ids: string[] = await window.evaluate(() => window.api.invoke('pty:active-ids'))
    const termId = ids.find((id) => id.startsWith('term-'))!
    expect(termId).toBeTruthy()
    return termId
  }

  test('id collisions: session restore with multiple visited paths', async () => {
    await app.close()
    await launch({ seedVisited: 3 })
    await window.waitForTimeout(1_000)
    await assertNoTerminalIdCollisions(window)
    const ids: string[] = await window.evaluate(() => window.api.invoke('pty:active-ids'))
    expect(new Set(ids).size, 'PTY id collision in main process').toBe(ids.length)
  })

  test('PTY + xterm survive a primary-pane sidebar switch', async () => {
    const termId = await waitForDefaultTerm()
    const marker = `MARKER_${Date.now()}`

    await window.evaluate(
      ({ id, marker }) => window.api.invoke('pty:write', id, `echo ${marker}\r`),
      { id: termId, marker },
    )
    await expect.poll(async () => await readTerminalText(window), { timeout: 5_000 }).toContain(marker)

    const before = await readLifecycle(window)
    const cBefore = before.filter((e) => e.id === termId && e.event === 'cleanup').length
    const sBefore = before.filter((e) => e.id === termId && e.event === 'setup').length

    const options = window.getByRole('listbox', { name: 'Worktrees' }).getByRole('option')
    await options.nth(1).click()
    await window.waitForTimeout(500)
    await options.first().click()
    await window.waitForTimeout(500)

    const after = await readLifecycle(window)
    const cDelta = after.filter((e) => e.id === termId && e.event === 'cleanup').length - cBefore
    const sDelta = after.filter((e) => e.id === termId && e.event === 'setup').length - sBefore

    const ids: string[] = await window.evaluate(() => window.api.invoke('pty:active-ids'))
    expect(ids).toContain(termId)
    expect(cDelta).toBe(0)
    expect(sDelta).toBe(0)
    expect(await readTerminalText(window)).toContain(marker)
    await assertNoTerminalIdCollisions(window)
  })

  test('PTY + xterm survive a switch to a never-visited worktree', async () => {
    const termId = await waitForDefaultTerm()
    const marker = `MARKER_${Date.now()}`

    await window.evaluate(
      ({ id, marker }) => window.api.invoke('pty:write', id, `echo ${marker}\r`),
      { id: termId, marker },
    )
    await expect.poll(async () => await readTerminalText(window), { timeout: 5_000 }).toContain(marker)

    const options = window.getByRole('listbox', { name: 'Worktrees' }).getByRole('option')
    if ((await options.count()) < 3) {
      test.skip(true, 'need ≥3 worktrees so the target is genuinely never-visited')
      return
    }

    const before = await readLifecycle(window)
    const cBefore = before.filter((e) => e.id === termId && e.event === 'cleanup').length
    const sBefore = before.filter((e) => e.id === termId && e.event === 'setup').length

    await options.nth(2).click()
    await window.waitForTimeout(800)
    await options.first().click()
    await window.waitForTimeout(500)

    const after = await readLifecycle(window)
    expect(after.filter((e) => e.id === termId && e.event === 'cleanup').length - cBefore).toBe(0)
    expect(after.filter((e) => e.id === termId && e.event === 'setup').length - sBefore).toBe(0)
    expect(await readTerminalText(window)).toContain(marker)
    await assertNoTerminalIdCollisions(window)
  })

  test('PTY + xterm survive rapid A→B→A→B switching', async () => {
    const termId = await waitForDefaultTerm()
    const marker = `MARKER_${Date.now()}`

    await window.evaluate(
      ({ id, marker }) => window.api.invoke('pty:write', id, `echo ${marker}\r`),
      { id: termId, marker },
    )
    await expect.poll(async () => await readTerminalText(window), { timeout: 5_000 }).toContain(marker)

    const before = await readLifecycle(window)
    const cBefore = before.filter((e) => e.id === termId && e.event === 'cleanup').length
    const sBefore = before.filter((e) => e.id === termId && e.event === 'setup').length

    const options = window.getByRole('listbox', { name: 'Worktrees' }).getByRole('option')
    for (let i = 0; i < 8; i++) {
      await options.nth(1).click()
      await options.first().click()
    }
    await window.waitForTimeout(800)

    const after = await readLifecycle(window)
    expect(after.filter((e) => e.id === termId && e.event === 'cleanup').length - cBefore).toBe(0)
    expect(after.filter((e) => e.id === termId && e.event === 'setup').length - sBefore).toBe(0)
    expect(await readTerminalText(window)).toContain(marker)
    await assertNoTerminalIdCollisions(window)
  })

  test('nested tmux session survives a worktree switch (the original #88 report)', async () => {
    const termId = await waitForDefaultTerm()
    const sessionName = `simpleedit-nested-${Date.now()}`

    await window.evaluate(
      ({ id, name }) =>
        window.api.invoke(
          'pty:write',
          id,
          `tmux new-session -s ${name} 'bash -c "while true; do echo NESTED_TICK_$(date +%s); sleep 1; done"'\r`,
        ),
      { id: termId, name: sessionName },
    )
    expect(
      await waitFor(window, async () => /NESTED_TICK_\d+/.test(await readTerminalText(window)), 10_000),
    ).toBe(true)

    const options = window.getByRole('listbox', { name: 'Worktrees' }).getByRole('option')
    await options.nth(1).click()
    await window.waitForTimeout(1_500)
    await options.first().click()
    await window.waitForTimeout(800)

    const ids: string[] = await window.evaluate(() => window.api.invoke('pty:active-ids'))
    expect(ids).toContain(termId)

    // C-b d to detach, then ask the shell if tmux still has the session.
    await window.evaluate(({ id }) => window.api.invoke('pty:write', id, '\x02d'), { id: termId })
    await window.waitForTimeout(500)
    await window.evaluate(
      ({ id, name }) =>
        window.api.invoke(
          'pty:write',
          id,
          ` tmux has-session -t ${name} 2>/dev/null && echo TMUX_ALIVE || echo TMUX_DEAD\r`,
        ),
      { id: termId, name: sessionName },
    )
    const status = await window.evaluate(async () => {
      for (let i = 0; i < 80; i++) {
        const text = Array.from(document.querySelectorAll('.xterm-rows > div'))
          .map((d) => d.textContent ?? '')
          .join('\n')
        if (/TMUX_ALIVE/.test(text)) return 'ALIVE'
        if (/TMUX_DEAD/.test(text)) return 'DEAD'
        await new Promise((r) => setTimeout(r, 100))
      }
      return 'TIMEOUT'
    })

    await window.evaluate(
      ({ id, name }) =>
        window.api.invoke('pty:write', id, `tmux kill-session -t ${name} 2>/dev/null ; true\r`),
      { id: termId, name: sessionName },
    )
    await window.waitForTimeout(300)
    expect(status).toBe('ALIVE')
  })

  test('fresh PTY output still reaches xterm after a switch', async () => {
    const termId = await waitForDefaultTerm()

    const options = window.getByRole('listbox', { name: 'Worktrees' }).getByRole('option')
    await options.nth(1).click()
    await window.waitForTimeout(500)
    await options.first().click()
    await window.waitForTimeout(500)

    const marker = `POST_SWITCH_${Date.now()}`
    await window.evaluate(
      ({ id, marker }) => window.api.invoke('pty:write', id, `echo ${marker}\r`),
      { id: termId, marker },
    )
    await expect.poll(async () => await readTerminalText(window), { timeout: 5_000 }).toContain(marker)
  })

  test('split layout: opening the secondary pane does not collide ids with the primary', async () => {
    await waitForDefaultTerm()

    await window.getByTitle('Split view').click()
    // Second pane mounts a new TerminalTabs in the same tick as the primary's
    // most recent re-render — if both auto-mint the default terminal id at the
    // same ms, ids collide (#88).
    await expect
      .poll(
        async () =>
          (await window.evaluate(() => window.api.invoke('pty:active-ids'))).filter((id: string) =>
            id.startsWith('term-'),
          ).length,
        { timeout: 10_000 },
      )
      .toBeGreaterThanOrEqual(2)

    const ids: string[] = (await window.evaluate(() => window.api.invoke('pty:active-ids'))).filter(
      (id: string) => id.startsWith('term-'),
    )
    expect(new Set(ids).size, 'split-layout PTY id collision in main process').toBe(ids.length)
    await assertNoTerminalIdCollisions(window)
  })

  test('Claude tab survives rapid worktree switching', async () => {
    await waitForDefaultTerm()

    await window.getByTitle('Run Claude Code').first().click()
    // Wait for the claude- PTY to land in main.
    await expect
      .poll(
        async () =>
          (await window.evaluate(() => window.api.invoke('pty:active-ids'))).some((id: string) =>
            id.startsWith('claude-'),
          ),
        { timeout: 10_000 },
      )
      .toBe(true)
    const before: string[] = await window.evaluate(() => window.api.invoke('pty:active-ids'))
    const claudeId = before.find((id) => id.startsWith('claude-'))!
    expect(claudeId).toBeTruthy()

    const options = window.getByRole('listbox', { name: 'Worktrees' }).getByRole('option')
    for (let i = 0; i < 10; i++) {
      await options.nth(1).click()
      await options.first().click()
    }
    await window.waitForTimeout(800)

    const after: string[] = await window.evaluate(() => window.api.invoke('pty:active-ids'))
    expect(after, 'Claude PTY died during rapid switching').toContain(claudeId)
    await assertNoTerminalIdCollisions(window)
  })

})
