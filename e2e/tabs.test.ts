/**
 * E2E tests for the unified tab model per worktree and the GitLog tour
 * affordance (issue #61).
 *
 * These tests describe the *finished* behavior and are expected to fail at
 * assertions against the current main-branch code. The parallel implementation
 * agent uses this file as the contract.
 *
 * Placeholder data-testids / aria names used below (noted at each use site)
 * are a suggestion to the impl agent — any equivalent user-visible selector
 * the implementation picks is fine, but if the testid strings differ the
 * matching assertions must be updated together.
 *
 *   data-testid="worktree-tab-bar"           — the pane-level tab bar
 *   data-testid="worktree-tab"               — each individual tab (data-kind,
 *                                              data-peek, data-active,
 *                                              data-unread attributes)
 *   data-testid="tab-kind-icon"              — leading icon per tab, with a
 *                                              data-kind attribute
 *   data-testid="gitlog-tour-icon"           — trailing tour icon on GitLog
 *                                              rows (data-has-tour attribute)
 *
 * If those testids end up named differently in the impl, do a project-wide
 * find-and-replace in this file along with the component.
 */
import { test, expect } from '@playwright/test'
import { _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { MAIN } from './fixtures'

const SANDBOX_ARGS = process.env.CI ? ['--no-sandbox'] : []
const repoPath = process.env.SIMPLEEDIT_TEST_REPO

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wait for the git log sidebar commit list to be populated. */
async function waitForCommits(window: Page): Promise<void> {
  const commitList = window.locator('[role="listbox"][aria-label="Commits"]')
  await expect(commitList).toBeVisible({ timeout: 10_000 })
  await expect(commitList.locator('[role="option"]').first()).toBeVisible({
    timeout: 10_000,
  })
}

/** Return the commit-row button at index `i` from the GitLog sidebar. */
function commitRow(window: Page, i: number) {
  return window
    .locator('[role="listbox"][aria-label="Commits"] [role="option"]')
    .nth(i)
}

/** Extract the short commit hash (monospace 7-char span) from a commit row. */
async function shortHashOfRow(window: Page, i: number): Promise<string> {
  const row = commitRow(window, i)
  const hashSpan = row.locator('span.font-mono').first()
  const text = await hashSpan.textContent()
  return (text ?? '').trim()
}

/** Locator for all pane-level tabs. Prefers [data-testid="worktree-tab"]. */
function allTabs(window: Page) {
  return window.locator('[data-testid="worktree-tab"]')
}

/** Locator for the currently-active pane-level tab. */
function activeTab(window: Page) {
  return window.locator('[data-testid="worktree-tab"][data-active="true"]')
}

/** Locator for the per-worktree tab bar (at least one pane's). */
function tabBar(window: Page) {
  return window.locator('[data-testid="worktree-tab-bar"]').first()
}

/** Fetch the first worktree path via IPC. */
async function getWorktreePath(window: Page): Promise<string> {
  return window.evaluate(() =>
    (
      window as unknown as {
        api: {
          invoke: (ch: string) => Promise<Array<{ path: string }>>
        }
      }
    ).api
      .invoke('worktree:list')
      .then((list) => list[0]?.path ?? '')
  )
}

/** Simulate a Claude-authored plan arriving via the main→renderer bridge. */
async function sendClaudePlan(
  app: ElectronApplication,
  window: Page,
  opts: { terminalId: string; overview: string }
): Promise<string> {
  const wt = await getWorktreePath(window)
  await app.evaluate(
    ({ BrowserWindow }, { wt: worktreePath, tid, overview }) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win) return
      win.webContents.send('plan:from-claude', {
        key: `${worktreePath}:claude-${tid}`,
        terminalId: tid,
        plan: {
          overview,
          tasks: [
            {
              id: 'tab-e2e-1',
              title: 'Unified tab model task',
              description: 'Stub task for the tab-model E2E suite',
              status: 'todo',
              reactions: [],
              discussion: [],
            },
          ],
        },
      })
    },
    { wt, tid: opts.terminalId, overview: opts.overview }
  )
  return wt
}

interface TourPayload {
  overview: string
  topics: Array<{
    title: string
    summary: string
    segments: Array<{ prose: string; file: string; lineRange: [number, number] }>
  }>
  openQuestions?: string[]
}

/** Simulate a Claude-authored tour arriving for a given commit (or staging). */
async function sendClaudeTour(
  app: ElectronApplication,
  window: Page,
  opts: { commitHash: string | null; terminalId?: string; tour?: TourPayload }
): Promise<string> {
  const wt = await getWorktreePath(window)
  const tour: TourPayload = opts.tour ?? {
    overview: 'Agent-authored tour for unified tab E2E.',
    topics: [
      {
        title: 'Stub topic',
        summary: 'Stub summary',
        segments: [
          {
            prose: 'Stub prose',
            file: 'README.md',
            lineRange: [1, 3],
          },
        ],
      },
    ],
  }
  await app.evaluate(
    ({ BrowserWindow }, { wt: worktreePath, tid, hash, t }) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win) return
      const key = `${worktreePath}:${hash ?? 'staging'}`
      win.webContents.send('tour:from-claude', {
        key,
        terminalId: tid,
        worktreePath,
        commitHash: hash,
        tour: t,
      })
    },
    {
      wt,
      tid: opts.terminalId ?? 'tabs-e2e-tour',
      hash: opts.commitHash,
      t: tour,
    }
  )
  return wt
}

// ---------------------------------------------------------------------------
// Scenarios 1–3: diff tabs, peek, pin
// ---------------------------------------------------------------------------

test.describe('#61 unified tabs — diff tabs, peek, pin', () => {
  test.skip(!repoPath, 'Set SIMPLEEDIT_TEST_REPO to run #61 tab tests')

  let app: ElectronApplication
  let window: Page

  test.beforeEach(async () => {
    app = await electron.launch({
      args: [MAIN, ...SANDBOX_ARGS],
      env: { ...process.env, SIMPLEEDIT_REPO: repoPath! },
    })
    window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await window.waitForTimeout(1500)
    await waitForCommits(window)
  })

  test.afterEach(async () => {
    await app.close()
  })

  test('opening three different commits produces three switchable diff tabs', async () => {
    // Need at least three commits to run this scenario meaningfully.
    const rowCount = await window
      .locator('[role="listbox"][aria-label="Commits"] [role="option"]')
      .count()
    test.skip(rowCount < 3, 'Repo has fewer than 3 commits — cannot test multi-diff.')

    // Pin each commit as it's opened so peek-replacement doesn't collapse them
    // into one tab. Double-click is the canonical pin affordance per spec.
    await commitRow(window, 0).dblclick()
    await window.waitForTimeout(400)
    await commitRow(window, 1).dblclick()
    await window.waitForTimeout(400)
    await commitRow(window, 2).dblclick()
    await window.waitForTimeout(400)

    // Three diff tabs should now exist simultaneously.
    const diffTabs = window.locator('[data-testid="worktree-tab"][data-kind="diff"]')
    await expect(diffTabs).toHaveCount(3, { timeout: 5_000 })

    // The third tab (most recently opened) should be active.
    await expect(diffTabs.nth(2)).toHaveAttribute('data-active', 'true')

    // Click the first diff tab → it becomes active; the others remain in the bar.
    await diffTabs.nth(0).click()
    await expect(diffTabs.nth(0)).toHaveAttribute('data-active', 'true')
    await expect(diffTabs).toHaveCount(3)

    // Clicking middle tab switches again without losing siblings.
    await diffTabs.nth(1).click()
    await expect(diffTabs.nth(1)).toHaveAttribute('data-active', 'true')
    await expect(diffTabs).toHaveCount(3)
  })

  test('single-click commit opens a peek diff tab that is replaced by the next peek', async () => {
    const rowCount = await window
      .locator('[role="listbox"][aria-label="Commits"] [role="option"]')
      .count()
    test.skip(rowCount < 2, 'Peek replacement needs at least 2 commits.')

    const hashA = await shortHashOfRow(window, 0)
    const hashB = await shortHashOfRow(window, 1)

    // Single-click commit A → one peek tab.
    await commitRow(window, 0).click()
    await window.waitForTimeout(400)

    const diffTabs = window.locator('[data-testid="worktree-tab"][data-kind="diff"]')
    await expect(diffTabs).toHaveCount(1, { timeout: 5_000 })
    await expect(diffTabs.first()).toHaveAttribute('data-peek', 'true')
    await expect(diffTabs.first()).toContainText(hashA)

    // Single-click commit B → peek is replaced, still exactly one diff tab.
    await commitRow(window, 1).click()
    await window.waitForTimeout(400)
    await expect(diffTabs).toHaveCount(1)
    await expect(diffTabs.first()).toHaveAttribute('data-peek', 'true')
    await expect(diffTabs.first()).toContainText(hashB)

    // Single-click commit A again → still exactly one peek, now showing A.
    await commitRow(window, 0).click()
    await window.waitForTimeout(400)
    await expect(diffTabs).toHaveCount(1)
    await expect(diffTabs.first()).toHaveAttribute('data-peek', 'true')
    await expect(diffTabs.first()).toContainText(hashA)
  })

  test('double-clicking a peek tab pins it; next peek opens a new tab alongside', async () => {
    const rowCount = await window
      .locator('[role="listbox"][aria-label="Commits"] [role="option"]')
      .count()
    test.skip(rowCount < 3, 'Pin test needs at least 3 commits.')

    // Open commit A as peek.
    await commitRow(window, 0).click()
    await window.waitForTimeout(400)

    const diffTabs = window.locator('[data-testid="worktree-tab"][data-kind="diff"]')
    await expect(diffTabs).toHaveCount(1)
    await expect(diffTabs.first()).toHaveAttribute('data-peek', 'true')

    // Double-click the peek tab → pin it.
    await diffTabs.first().dblclick()
    await window.waitForTimeout(300)
    await expect(diffTabs.first()).toHaveAttribute('data-peek', 'false')

    // Single-click commit C → opens a new peek alongside the pinned tab.
    await commitRow(window, 2).click()
    await window.waitForTimeout(400)
    await expect(diffTabs).toHaveCount(2, { timeout: 3_000 })

    // Exactly one of the two is now peek, the other (the original) is pinned.
    const peekTabs = window.locator(
      '[data-testid="worktree-tab"][data-kind="diff"][data-peek="true"]'
    )
    const pinnedTabs = window.locator(
      '[data-testid="worktree-tab"][data-kind="diff"][data-peek="false"]'
    )
    await expect(peekTabs).toHaveCount(1)
    await expect(pinnedTabs).toHaveCount(1)
  })
})

// ---------------------------------------------------------------------------
// Scenarios 4–5: GitLog tour icon
// ---------------------------------------------------------------------------

test.describe('#61 unified tabs — GitLog tour icon', () => {
  test.skip(!repoPath, 'Set SIMPLEEDIT_TEST_REPO to run #61 tab tests')

  let app: ElectronApplication
  let window: Page

  test.beforeEach(async () => {
    app = await electron.launch({
      args: [MAIN, ...SANDBOX_ARGS],
      env: { ...process.env, SIMPLEEDIT_REPO: repoPath! },
    })
    window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await window.waitForTimeout(1500)
    await waitForCommits(window)
  })

  test.afterEach(async () => {
    await app.close()
  })

  test('hovering a commit row reveals the trailing tour icon; clicking it opens a tour tab', async () => {
    const row = commitRow(window, 0)

    // Before hover the tour icon should not be actionable (may be hidden, may
    // have visibility:hidden — we just assert it's not clickable from the idle
    // state). This is a soft expectation so that implementations which always
    // render the icon but gate visibility differently don't fail here.
    const tourIcon = row.locator('[data-testid="gitlog-tour-icon"]')

    await row.hover()
    await expect(tourIcon).toBeVisible({ timeout: 3_000 })

    await tourIcon.click()
    await window.waitForTimeout(500)

    // A tour tab should now be open and active.
    const tourTabs = window.locator(
      '[data-testid="worktree-tab"][data-kind="tour"]'
    )
    await expect(tourTabs).toHaveCount(1, { timeout: 5_000 })
    await expect(tourTabs.first()).toHaveAttribute('data-active', 'true')
  })

  test('commits that already have a tour show the tour icon in a highlighted state regardless of hover', async () => {
    // Seed a tour for the first commit by dispatching a tour-from-Claude IPC.
    const hash0 = await shortHashOfRow(window, 0)
    // shortHashOfRow returns the short 7-char; the store keys on the full hash,
    // but the GitLog row correlates by its own data via the short hash. The
    // impl should expose whichever hash form it already stores — we identify
    // the row by index, not hash, in the assertion below.
    await sendClaudeTour(app, window, {
      commitHash: hash0,
      terminalId: 'tabs-e2e-seed',
    })

    // Give the renderer a tick to process the tour event.
    await window.waitForTimeout(1_000)

    // The first row's tour icon should now be in a highlighted / has-tour state
    // without requiring hover. We assert visibility + data-has-tour="true"
    // while the mouse is parked far away from the row.
    await window.mouse.move(0, 0)

    const row = commitRow(window, 0)
    const tourIcon = row.locator('[data-testid="gitlog-tour-icon"]')
    await expect(tourIcon).toBeVisible({ timeout: 5_000 })
    await expect(tourIcon).toHaveAttribute('data-has-tour', 'true')

    // A row we did not seed should either not have the icon visible at idle,
    // or should explicitly report data-has-tour="false". We use a flexible
    // assertion: we only require that its has-tour state is not "true".
    const row1Icon = commitRow(window, 1).locator(
      '[data-testid="gitlog-tour-icon"]'
    )
    const hasTour1 = await row1Icon
      .getAttribute('data-has-tour')
      .catch(() => null)
    expect(hasTour1).not.toBe('true')
  })
})

// ---------------------------------------------------------------------------
// Scenarios 6–7: agent-initiated tabs, unread, auto-focus
// ---------------------------------------------------------------------------

test.describe('#61 unified tabs — agent-initiated tabs', () => {
  test.skip(!repoPath, 'Set SIMPLEEDIT_TEST_REPO to run #61 tab tests')

  let app: ElectronApplication
  let window: Page

  test.beforeEach(async () => {
    app = await electron.launch({
      args: [MAIN, ...SANDBOX_ARGS],
      env: { ...process.env, SIMPLEEDIT_REPO: repoPath! },
    })
    window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await window.waitForTimeout(1500)
    await waitForCommits(window)
  })

  test.afterEach(async () => {
    await app.close()
  })

  test('agent-initiated tab opens in background with unread marker when the pane is busy', async () => {
    // Make the pane busy: open a commit diff tab the user is actively viewing.
    await commitRow(window, 0).dblclick()
    await window.waitForTimeout(400)
    const diffTabs = window.locator('[data-testid="worktree-tab"][data-kind="diff"]')
    await expect(diffTabs.first()).toHaveAttribute('data-active', 'true', {
      timeout: 5_000,
    })

    // Agent dispatches a plan — since pane has an active tab, plan should
    // arrive in the background with the unread marker.
    await sendClaudePlan(app, window, {
      terminalId: 'bg-plan',
      overview: 'Background plan',
    })
    await window.waitForTimeout(1_000)

    const planTabs = window.locator(
      '[data-testid="worktree-tab"][data-kind="plan"]'
    )
    await expect(planTabs).toHaveCount(1, { timeout: 5_000 })

    // It should not be active …
    await expect(planTabs.first()).toHaveAttribute('data-active', 'false')
    // … and should be flagged unread.
    await expect(planTabs.first()).toHaveAttribute('data-unread', 'true')

    // The diff tab the user was on should still be active.
    await expect(diffTabs.first()).toHaveAttribute('data-active', 'true')

    // Clicking the plan tab clears the unread flag.
    await planTabs.first().click()
    await window.waitForTimeout(300)
    await expect(planTabs.first()).toHaveAttribute('data-active', 'true')
    await expect(planTabs.first()).toHaveAttribute('data-unread', 'false')
  })

  test('agent-initiated tab auto-focuses when the pane is idle (no active tab)', async () => {
    // Fresh launch: no tab is open, pane is idle.
    await expect(allTabs(window)).toHaveCount(0, { timeout: 3_000 })

    await sendClaudePlan(app, window, {
      terminalId: 'idle-plan',
      overview: 'Idle plan — should auto-focus',
    })
    await window.waitForTimeout(1_000)

    const planTabs = window.locator(
      '[data-testid="worktree-tab"][data-kind="plan"]'
    )
    await expect(planTabs).toHaveCount(1, { timeout: 5_000 })
    // Auto-focus → active, not unread.
    await expect(planTabs.first()).toHaveAttribute('data-active', 'true')
    await expect(planTabs.first()).toHaveAttribute('data-unread', 'false')
  })
})

// ---------------------------------------------------------------------------
// Scenarios 8–9: tab icons, peek scope
// ---------------------------------------------------------------------------

test.describe('#61 unified tabs — icons and peek scope', () => {
  test.skip(!repoPath, 'Set SIMPLEEDIT_TEST_REPO to run #61 tab tests')

  let app: ElectronApplication
  let window: Page

  test.beforeEach(async () => {
    app = await electron.launch({
      args: [MAIN, ...SANDBOX_ARGS],
      env: { ...process.env, SIMPLEEDIT_REPO: repoPath! },
    })
    window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await window.waitForTimeout(1500)
    await waitForCommits(window)
  })

  test.afterEach(async () => {
    await app.close()
  })

  test('each tab kind renders a distinct leading icon', async () => {
    // Diff tab: open a commit (peek is fine).
    await commitRow(window, 0).click()
    await window.waitForTimeout(400)

    // File tab: click a file in the tree.
    const fileNode = window.locator('[role="treeitem"]').first()
    await expect(fileNode).toBeVisible({ timeout: 5_000 })
    await fileNode.click()
    await window.waitForTimeout(400)

    // Plan tab: via agent bridge.
    await sendClaudePlan(app, window, {
      terminalId: 'icon-plan',
      overview: 'Plan for icon test',
    })
    await window.waitForTimeout(500)

    // Tour tab: via agent bridge.
    await sendClaudeTour(app, window, {
      commitHash: null,
      terminalId: 'icon-tour',
    })
    await window.waitForTimeout(500)

    // Every open tab should render an icon element labeled with its kind.
    for (const kind of ['file', 'diff', 'tour', 'plan']) {
      const iconsForKind = window.locator(
        `[data-testid="worktree-tab"][data-kind="${kind}"] [data-testid="tab-kind-icon"]`
      )
      await expect(
        iconsForKind.first(),
        `expected at least one "${kind}" tab icon to be rendered`
      ).toBeVisible({ timeout: 5_000 })
      // The icon element should be tagged with its kind so we know the
      // implementation is not rendering the same glyph for every kind.
      await expect(iconsForKind.first()).toHaveAttribute('data-kind', kind)
    }

    // All four kind-icons should be distinct elements by virtue of their
    // data-kind attributes — i.e. four icons with four unique `data-kind`s.
    const allKindIcons = window.locator('[data-testid="tab-kind-icon"]')
    const count = await allKindIcons.count()
    expect(count).toBeGreaterThanOrEqual(4)

    const seen = new Set<string>()
    for (let i = 0; i < count; i++) {
      const k = await allKindIcons.nth(i).getAttribute('data-kind')
      if (k) seen.add(k)
    }
    expect(seen).toEqual(new Set(['file', 'diff', 'tour', 'plan']))
  })

  test('plan and tour tabs are sticky: subsequent peek actions do not replace them', async () => {
    // Open a Claude plan tab — this is agent-initiated and sticky.
    await sendClaudePlan(app, window, {
      terminalId: 'sticky-plan',
      overview: 'Sticky plan — should survive peek actions',
    })
    await window.waitForTimeout(800)

    const planTabs = window.locator(
      '[data-testid="worktree-tab"][data-kind="plan"]'
    )
    await expect(planTabs).toHaveCount(1, { timeout: 5_000 })

    // Open a Claude tour — also sticky.
    await sendClaudeTour(app, window, {
      commitHash: null,
      terminalId: 'sticky-tour',
    })
    await window.waitForTimeout(800)

    const tourTabs = window.locator(
      '[data-testid="worktree-tab"][data-kind="tour"]'
    )
    await expect(tourTabs).toHaveCount(1, { timeout: 5_000 })

    // Now fire off a couple of peek-style diff opens via single-click.
    await commitRow(window, 0).click()
    await window.waitForTimeout(400)
    if (
      (await window
        .locator('[role="listbox"][aria-label="Commits"] [role="option"]')
        .count()) > 1
    ) {
      await commitRow(window, 1).click()
      await window.waitForTimeout(400)
    }

    // Plan and tour tabs must still be present exactly once each — peek
    // replacement is scoped to file/diff kinds only.
    await expect(planTabs).toHaveCount(1)
    await expect(tourTabs).toHaveCount(1)

    // Plan/tour must never be marked as peek tabs.
    await expect(planTabs.first()).toHaveAttribute('data-peek', 'false')
    await expect(tourTabs.first()).toHaveAttribute('data-peek', 'false')

    // At most one diff tab remains (the peek slot) because we never pinned
    // either of the two diffs we opened.
    const diffTabs = window.locator(
      '[data-testid="worktree-tab"][data-kind="diff"]'
    )
    const diffCount = await diffTabs.count()
    expect(diffCount).toBeLessThanOrEqual(1)
  })

  test('the per-worktree tab bar is rendered for the pane', async () => {
    // Sanity: once any tab is open the tab bar must exist and be visible.
    await commitRow(window, 0).click()
    await window.waitForTimeout(400)
    await expect(tabBar(window)).toBeVisible({ timeout: 5_000 })
    await expect(activeTab(window)).toHaveCount(1)
  })
})
