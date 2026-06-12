/**
 * Regression guards for the Terminal/PTY lifecycle, ported to the agent-first UI.
 *
 * Origin story (#88): users reported that long-running terminal work — tmux
 * sessions, Claude agent teams, anything with a continuously-attached PTY —
 * vanished when the pane's worktree was switched away and back. The PTY in
 * main was alive; the xterm renderer in the visible pane was blank.
 *
 * In the agent-first UI one session = one PTY = one workspace, and switching
 * happens between SESSIONS in the sidebar (WorkspaceManager keeps every
 * visited workspace mounted but hidden). The invariant under test is the same:
 * switching away from a session and back must not tear down / re-attach its
 * xterm (no cleanup/setup events for its terminal id), and the PTY in main
 * must survive with its scrollback intact.
 *
 * The guard reads `window.__simpleeditTerminalLifecycle__`, instrumented in
 * `Terminal.svelte`, which records one event per setup/cleanup. Any terminalId
 * with more than one `setup` event means two components attached to the same
 * id — i.e. the #88 bug is back.
 */
import { _electron as electron } from '@playwright/test'
import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import {
  MAIN,
  launchEnv,
  spawnTerminalSession,
  spawnClaudeSession,
  createTempRepo,
  removeTempRepo,
  clearSavedSessionFile
} from './fixtures'
const SANDBOX_ARGS = process.env.CI ? ['--no-sandbox'] : []
const repoPath = process.env.SIMPLEEDIT_TEST_REPO

interface LifecycleEvent {
  event: 'setup' | 'cleanup'
  id: string
  t: number
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

  let repo: ReturnType<typeof createTempRepo>
  test.beforeAll(() => {
    repo = createTempRepo('simpleedit-e2e-')
  })
  test.afterAll(() => {
    removeTempRepo(repo)
  })

  async function launch(): Promise<void> {
    clearSavedSessionFile(repo.bareRepoPath)
    app = await electron.launch({
      args: [MAIN, ...SANDBOX_ARGS],
      env: launchEnv({ SIMPLEEDIT_REPO: repo.bareRepoPath }),
    })
    window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await window.evaluate(() => {
      ;(window as unknown as { __simpleeditTerminalLifecycle__: unknown[] }).__simpleeditTerminalLifecycle__ = []
    })
  }

  test.beforeEach(async () => {
    await launch()
  })

  test.afterEach(async () => {
    await app.close()
  })

  /** Session entries in the sidebar Sessions listbox, in display order. */
  function sessionOptions() {
    return window.getByRole('listbox', { name: 'Sessions' }).getByRole('option')
  }

  /**
   * Spawn terminal sessions A then B. B is auto-selected on creation, so A's
   * workspace is hidden-but-mounted — the state #88 is about.
   */
  async function spawnTwoTerminals(): Promise<{ termA: string; termB: string }> {
    const termA = await spawnTerminalSession(window)
    const termB = await spawnTerminalSession(window)
    await expect(sessionOptions()).toHaveCount(2)
    return { termA, termB }
  }

  /**
   * Click the nth session entry. Selection is positional, not by label —
   * terminal sessions have no customLabel, so a chatty shell's OSC title can
   * rename them mid-test. Terminal sessions append in creation order (claude
   * sessions prepend), and the list does not reorder on select.
   */
  async function selectSession(index: number): Promise<void> {
    await sessionOptions().nth(index).click()
    await window.waitForTimeout(300)
  }

  // NOTE: two tests from the worktree-pane era were deleted in the agent-first
  // port:
  //  - "id collisions: session restore with multiple visited paths" — restored
  //    sessions are click-to-resume placeholders now; nothing auto-mints
  //    terminal ids at mount, so the same-tick collision scenario cannot occur.
  //  - "split layout: opening the secondary pane does not collide ids" — the
  //    Split/secondary-pane feature was removed outright.

  test('PTY + xterm survive a session switch (away and back)', async () => {
    const { termA } = await spawnTwoTerminals()
    // We're on B now (auto-selected). Go back to A and lay down a marker.
    await selectSession(0)
    const marker = `MARKER_${Date.now()}`

    await window.evaluate(
      ({ id, marker }) => window.api.invoke('pty:write', id, `echo ${marker}\r`),
      { id: termA, marker },
    )
    await expect.poll(async () => await readTerminalText(window), { timeout: 5_000 }).toContain(marker)

    const before = await readLifecycle(window)
    const cBefore = before.filter((e) => e.id === termA && e.event === 'cleanup').length
    const sBefore = before.filter((e) => e.id === termA && e.event === 'setup').length

    await selectSession(1)
    await selectSession(0)

    const after = await readLifecycle(window)
    const cDelta = after.filter((e) => e.id === termA && e.event === 'cleanup').length - cBefore
    const sDelta = after.filter((e) => e.id === termA && e.event === 'setup').length - sBefore

    const ids: string[] = await window.evaluate(() => window.api.invoke('pty:active-ids'))
    expect(ids).toContain(termA)
    expect(cDelta).toBe(0)
    expect(sDelta).toBe(0)
    expect(await readTerminalText(window)).toContain(marker)
    await assertNoTerminalIdCollisions(window)
  })

  test('PTY + xterm survive rapid A→B→A→B switching', async () => {
    const { termA } = await spawnTwoTerminals()
    await selectSession(0)
    const marker = `MARKER_${Date.now()}`

    await window.evaluate(
      ({ id, marker }) => window.api.invoke('pty:write', id, `echo ${marker}\r`),
      { id: termA, marker },
    )
    await expect.poll(async () => await readTerminalText(window), { timeout: 5_000 }).toContain(marker)

    const before = await readLifecycle(window)
    const cBefore = before.filter((e) => e.id === termA && e.event === 'cleanup').length
    const sBefore = before.filter((e) => e.id === termA && e.event === 'setup').length

    for (let i = 0; i < 8; i++) {
      await sessionOptions().nth(1).click()
      await sessionOptions().nth(0).click()
    }
    await window.waitForTimeout(800)

    const after = await readLifecycle(window)
    expect(after.filter((e) => e.id === termA && e.event === 'cleanup').length - cBefore).toBe(0)
    expect(after.filter((e) => e.id === termA && e.event === 'setup').length - sBefore).toBe(0)
    expect(await readTerminalText(window)).toContain(marker)
    await assertNoTerminalIdCollisions(window)
  })

  test('nested tmux session survives a session switch (the original #88 report)', async () => {
    const { termA } = await spawnTwoTerminals()
    await selectSession(0)
    const sessionName = `simpleedit-nested-${Date.now()}`

    await window.evaluate(
      ({ id, name }) =>
        window.api.invoke(
          'pty:write',
          id,
          `tmux new-session -s ${name} 'bash -c "while true; do echo NESTED_TICK_$(date +%s); sleep 1; done"'\r`,
        ),
      { id: termA, name: sessionName },
    )
    expect(
      await waitFor(window, async () => /NESTED_TICK_\d+/.test(await readTerminalText(window)), 10_000),
    ).toBe(true)

    await selectSession(1)
    await window.waitForTimeout(1_500)
    await selectSession(0)
    await window.waitForTimeout(800)

    const ids: string[] = await window.evaluate(() => window.api.invoke('pty:active-ids'))
    expect(ids).toContain(termA)

    // C-b d to detach, then ask the shell if tmux still has the session.
    await window.evaluate(({ id }) => window.api.invoke('pty:write', id, '\x02d'), { id: termA })
    await window.waitForTimeout(500)
    await window.evaluate(
      ({ id, name }) =>
        window.api.invoke(
          'pty:write',
          id,
          ` tmux has-session -t ${name} 2>/dev/null && echo TMUX_ALIVE || echo TMUX_DEAD\r`,
        ),
      { id: termA, name: sessionName },
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
      { id: termA, name: sessionName },
    )
    await window.waitForTimeout(300)
    expect(status).toBe('ALIVE')
  })

  test('fresh PTY output still reaches xterm after a session switch', async () => {
    const { termA } = await spawnTwoTerminals()

    // Away (we're on B) and back to A — then write fresh output.
    await selectSession(0)
    await selectSession(1)
    await selectSession(0)

    const marker = `POST_SWITCH_${Date.now()}`
    await window.evaluate(
      ({ id, marker }) => window.api.invoke('pty:write', id, `echo ${marker}\r`),
      { id: termA, marker },
    )
    await expect.poll(async () => await readTerminalText(window), { timeout: 5_000 }).toContain(marker)
  })

  test('Claude session survives rapid session switching', async () => {
    const claudeId = await spawnClaudeSession(window)
    await spawnTerminalSession(window)
    await expect(sessionOptions()).toHaveCount(2)

    // Rapidly bounce between the two sessions (claude prepends → nth(0) is
    // the Claude session, nth(1) the terminal).
    for (let i = 0; i < 10; i++) {
      await sessionOptions().nth(1).click()
      await sessionOptions().nth(0).click()
    }
    await window.waitForTimeout(800)

    const after: string[] = await window.evaluate(() => window.api.invoke('pty:active-ids'))
    expect(after, 'Claude PTY died during rapid switching').toContain(claudeId)
    await assertNoTerminalIdCollisions(window)
  })
})
