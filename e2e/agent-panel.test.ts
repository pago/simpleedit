/**
 * E2E tests for agent-composed panels (`show_panel`): panel identity, the
 * DiffBlock primitive, and per-block "Discuss this".
 *
 * Like complete-task.test.ts, we can't spawn a real Claude session, so we
 * dispatch the `agent-panel:open` IPC from the Electron main context — the exact
 * payload mcp-bridge sends after validating a spec — and assert the renderer.
 *
 * This suite is self-sufficient (its own temp repo), so unlike the older suites
 * it does not gate on SIMPLEEDIT_TEST_REPO and therefore runs in CI.
 */
import { test, expect } from '@playwright/test'
import { _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { MAIN, launchEnv, spawnClaudeSession, clearSavedSessionFile, createTempRepo, removeTempRepo } from './fixtures'

const SANDBOX_ARGS = process.env.CI ? ['--no-sandbox'] : []

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,1 +1,2 @@',
  ' export const a = 1',
  '+export const added = 2',
].join('\n')

interface Spec {
  root: string
  elements: Record<string, { type: string; props: Record<string, unknown>; children?: string[] }>
}

test.describe('show_panel — composed panels', () => {
  let app: ElectronApplication
  let window: Page
  let sessionId: string
  let repo: ReturnType<typeof createTempRepo>

  test.beforeAll(() => {
    repo = createTempRepo('simpleedit-panel-')
  })
  test.afterAll(() => {
    removeTempRepo(repo)
  })

  test.beforeEach(async () => {
    clearSavedSessionFile(repo.bareRepoPath)
    app = await electron.launch({
      args: [MAIN, ...SANDBOX_ARGS],
      env: launchEnv({ SIMPLEEDIT_REPO: repo.bareRepoPath }),
    })
    window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    // Panels route per session — create the workspace that will receive them.
    sessionId = await spawnClaudeSession(window)
  })

  test.afterEach(async () => {
    await app.close()
  })

  async function sendPanel(spec: Spec, title: string, panelId?: string): Promise<void> {
    await app.evaluate(
      ({ BrowserWindow }, payload) => {
        BrowserWindow.getAllWindows()[0]?.webContents.send('agent-panel:open', payload)
      },
      {
        spec,
        title,
        worktreePath: repo.mainWorktreePath,
        sourceTerminalId: sessionId,
        ...(panelId ? { panelId } : {}),
      },
    )
  }

  const panelTabs = () => window.locator('[data-testid="worktree-tab"][data-kind="composed"]:visible')

  const proseSpec = (text: string): Spec => ({
    root: 'p',
    elements: { p: { type: 'ProseBlock', props: { content: text } } },
  })

  test('distinct panelIds coexist as separate tabs; the same id updates in place', async () => {
    await sendPanel(proseSpec('tour step one'), 'Tour', 'tour')
    await expect(panelTabs()).toHaveCount(1, { timeout: 10_000 })

    await sendPanel(proseSpec('pick an approach'), 'Decision', 'decision')
    await expect(panelTabs()).toHaveCount(2, { timeout: 10_000 })

    // Re-sending an existing id must not add a third tab.
    await sendPanel(proseSpec('tour step two'), 'Tour', 'tour')
    await expect(panelTabs()).toHaveCount(2, { timeout: 10_000 })
    await panelTabs().first().click()
    await expect(window.getByText('tour step two')).toBeVisible({ timeout: 10_000 })
  })

  test('a panel without a panelId keeps replacing the session panel in place', async () => {
    await sendPanel(proseSpec('first'), 'Agent panel')
    await expect(panelTabs()).toHaveCount(1, { timeout: 10_000 })
    await sendPanel(proseSpec('second'), 'Agent panel')
    await expect(panelTabs()).toHaveCount(1, { timeout: 10_000 })
  })

  test('DiffBlock renders the diff from text alone, expanded, plumbing stripped', async () => {
    await sendPanel(
      {
        root: 'd',
        elements: { d: { type: 'DiffBlock', props: { diff: DIFF, title: 'The change' } } },
      },
      'Tour',
      'diff',
    )
    await expect(panelTabs()).toHaveCount(1, { timeout: 10_000 })

    await expect(window.getByText('The change')).toBeVisible({ timeout: 10_000 })
    await expect(window.getByText('src/a.ts', { exact: true })).toBeVisible()
    // Expanded by default — no disclosure to click.
    await expect(window.getByText('export const added = 2')).toBeVisible()
    // git plumbing is not rendered.
    await expect(window.getByText(/index 1111111/)).toHaveCount(0)
  })

  test('focus_block jumps to a block inside a collapsed Section and flashes it', async () => {
    await sendPanel(
      {
        root: 'tour',
        elements: {
          // A "read in this order" list above a step that starts collapsed —
          // the case a tour hits: the target is not in the DOM until we expand.
          tour: { type: 'Section', props: { title: 'Retry handling' }, children: ['index', 'step'] },
          index: {
            type: 'FileList',
            props: {
              title: 'Read in this order',
              items: [
                {
                  path: 'src/a.ts',
                  detail: 'Start here: the added export is what the rest of the tour builds on.',
                  action: { type: 'focus_block', blockId: 'diff' },
                },
              ],
            },
          },
          step: {
            type: 'Section',
            props: { title: 'Step 1', defaultOpen: false },
            children: ['diff'],
          },
          diff: { type: 'DiffBlock', props: { diff: DIFF, title: 'The change' } },
        },
      },
      'Tour',
      'focus',
    )
    await expect(panelTabs()).toHaveCount(1, { timeout: 10_000 })

    // A sentence-length detail is shown in full, not truncated to a chip.
    await expect(
      window.getByText('Start here: the added export is what the rest of the tour builds on.'),
    ).toBeVisible({ timeout: 10_000 })

    // Collapsed: the DiffBlock is not rendered at all yet.
    await expect(window.getByText('The change')).toHaveCount(0)

    await window.getByRole('button', { name: /src\/a\.ts/ }).click()

    // The collapsed step opened on the way, so the jump actually lands.
    await expect(window.getByText('The change')).toBeVisible({ timeout: 5000 })
    await expect(window.getByText('export const added = 2')).toBeVisible()
    await expect(
      window.locator('[data-block-id="step"] [data-section-toggle]'),
    ).toHaveAttribute('aria-expanded', 'true')
    // (The arrival flash is time-boxed, so it is asserted in focus-block.test.ts
    // rather than raced against here.)
  })

  test('a Callout body renders markdown instead of one run-on line', async () => {
    await sendPanel(
      {
        root: 'c',
        elements: {
          c: {
            type: 'Callout',
            props: {
              variant: 'warn',
              title: 'Two things to know',
              body: 'First paragraph here.\n\n- one bullet\n- another bullet',
            },
          },
        },
      },
      'Tour',
      'callout',
    )
    await expect(panelTabs()).toHaveCount(1, { timeout: 10_000 })

    const callout = window.locator('[data-block-id="c"]')
    await expect(callout.locator('p', { hasText: 'First paragraph here.' })).toBeVisible({
      timeout: 10_000,
    })
    await expect(callout.locator('li')).toHaveCount(2)
  })

  test('a Diagram carries its own title, with no ProseBlock above it', async () => {
    await sendPanel(
      {
        root: 'd',
        elements: {
          d: {
            type: 'Diagram',
            props: {
              kind: 'graph',
              title: 'Request path',
              nodes: [
                { id: 'a', label: 'Client' },
                { id: 'b', label: 'API' },
              ],
              edges: [{ source: 'a', target: 'b' }],
            },
          },
        },
      },
      'Tour',
      'diagram',
    )
    await expect(panelTabs()).toHaveCount(1, { timeout: 10_000 })
    await expect(window.locator('[data-block-id="d"]').getByText('Request path')).toBeVisible({
      timeout: 10_000,
    })
  })

  test('selecting text in a block offers Discuss this and opens the agent popover', async () => {
    await sendPanel(
      {
        root: 'sec',
        elements: {
          sec: { type: 'Section', props: { title: 'Step 1' }, children: ['prose', 'diff'] },
          prose: { type: 'ProseBlock', props: { content: 'discussable prose paragraph' } },
          diff: { type: 'DiffBlock', props: { diff: DIFF } },
        },
      },
      'Tour',
      'discuss',
    )
    await expect(panelTabs()).toHaveCount(1, { timeout: 10_000 })

    const prose = window.getByText('discussable prose paragraph')
    await expect(prose).toBeVisible({ timeout: 10_000 })
    // Drag-select across the paragraph the way a user would. (A double-click
    // is unreliable here: the markdown paragraph's centre is the trailing
    // newline, so Chromium selects only "\n".)
    const box = (await prose.boundingBox())!
    await window.mouse.move(box.x + 2, box.y + box.height / 2)
    await window.mouse.down()
    await window.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 8 })
    await window.mouse.up()

    const pill = window.getByRole('button', { name: /Discuss this/ })
    await expect(pill).toBeVisible({ timeout: 5000 })
    await pill.click()

    // The popover header names the block the selection came from.
    await expect(window.getByPlaceholder('Discuss this with agent...')).toBeVisible({ timeout: 5000 })
    await expect(window.getByText('panel · ProseBlock · prose')).toBeVisible()
  })
})
