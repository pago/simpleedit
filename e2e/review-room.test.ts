import { test as base, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { createHash } from 'crypto'
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  MAIN,
  launchEnv,
  createTempRepo,
  removeTempRepo,
  sessionOption,
  spawnClaudeSession,
  waitForWorktreesReady,
  type TempRepo,
} from './fixtures'
import type { Review, ReviewSnapshot } from '../src/shared/review-room'
import type { PrReviewComment } from '../src/shared/screenprs'

/**
 * The Review Room end to end: open a two-layer stack from Screen PRs, ask the
 * hidden companion, post per layer, restore, and share one review between two
 * windows.
 *
 * GitHub is `e2e/support/fake-gh.mjs` first on PATH: it serves the stack from
 * a fixture, keeps pending reviews across calls, and logs every request, so
 * the GraphQL posting can be asserted call by call. The companion is the fake
 * `claude` (e2e/bin) with SIMPLEEDIT_FAKE_CLAUDE_COMPANION=1: it answers a
 * typed review-thread prompt through the window's real bridge, confirming it
 * with `UserPromptSubmit`, replying with `reply_to_thread`, and ending the
 * turn with `Stop`, which is everything the delivery core waits for.
 *
 * Reviews live in the app's shared database, so every stack gets a repo name
 * no other run uses, and each test discards what it left open.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SANDBOX_ARGS = process.env.CI ? ['--no-sandbox'] : []

const hasNode = (() => {
  try {
    execSync('command -v node', { stdio: 'ignore', shell: '/bin/sh' })
    return true
  } catch {
    return false
  }
})()

// ── the stack ────────────────────────────────────────────────────────────────

const BOTTOM = 11
const TOP = 12
const TOP_TITLE = 'Clamp to a named limit'

const sha = (seed: string): string => createHash('sha1').update(seed).digest('hex')

const BOTTOM_DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1,2 @@
 export const a = 1
+export const a2 = 2
`

const TOP_DIFF = `diff --git a/src/stack.ts b/src/stack.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/stack.ts
@@ -0,0 +1,4 @@
+export const LIMIT = 10
+export function clamp(n: number): number {
+  return Math.min(n, LIMIT)
+}
`

/** An existing, unresolved GitHub thread on the top layer's line 1. */
const GITHUB_THREAD = {
  id: 'PRRT_e2e_existing',
  isResolved: false,
  isOutdated: false,
  path: 'src/stack.ts',
  line: 1,
  originalLine: 1,
  diffSide: 'RIGHT',
  comments: {
    nodes: [
      {
        id: 'PRRC_e2e_existing',
        databaseId: 4242,
        fullDatabaseId: '4242',
        author: { login: 'octo-reviewer' },
        body: 'Why is this a constant?',
      },
    ],
    pageInfo: { hasNextPage: false, endCursor: null },
  },
}

interface Stack {
  repo: TempRepo
  /** The GitHub repo name, unique to this stack. */
  name: string
  /** Holds the fake gh's fixture, state and request log. */
  ghDir: string
  binDir: string
  bottomUrl: string
  topUrl: string
  bottomHead: string
  topHead: string
}

/** What the fake gh serves; `threads` are each PR's existing GitHub review threads, by number. */
function writeFixture(stack: Stack, threads: Record<string, unknown[]> = {}): void {
  const { name } = stack
  const mainSha = sha(`${name}:main`)
  const pr = (number: number, title: string, head: string, base: string, headSha: string, baseSha: string, diff: string, subject: string) => ({
    number,
    title,
    url: number === BOTTOM ? stack.bottomUrl : stack.topUrl,
    author: 'stack-author',
    headRefName: head,
    baseRefName: base,
    headRefOid: headSha,
    baseRefOid: baseSha,
    additions: diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).length,
    deletions: 0,
    changedFiles: 1,
    body: `${title}.`,
    diff,
    commits: [{ oid: headSha, subject, authoredAt: '2026-10-15T10:00:00Z' }],
  })
  const fixture = {
    login: 'me',
    repo: { host: 'github.com', owner: 'se-e2e', name, defaultBranch: 'main' },
    prs: [
      pr(BOTTOM, 'Add a second constant', 'feat-a', 'main', stack.bottomHead, mainSha, BOTTOM_DIFF, 'Add a2'),
      pr(TOP, TOP_TITLE, 'feat-b', 'feat-a', stack.topHead, stack.bottomHead, TOP_DIFF, 'Add clamp'),
    ],
    threads,
  }
  fs.writeFileSync(path.join(stack.ghDir, 'fixture.json'), JSON.stringify(fixture, null, 2))
}

function createStack(tag: string): Stack {
  const repo = createTempRepo(`simpleedit-review-room-${tag}-`)
  const name = `rr-${tag}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const ghDir = path.join(repo.root, 'fake-gh')
  const binDir = path.join(repo.root, 'fake-gh-bin')
  fs.mkdirSync(ghDir, { recursive: true })
  fs.mkdirSync(binDir, { recursive: true })
  const script = path.join(__dirname, 'support', 'fake-gh.mjs')
  fs.writeFileSync(path.join(binDir, 'gh'), `#!/usr/bin/env bash\nexec node ${JSON.stringify(script)} "$@"\n`, { mode: 0o755 })
  const stack: Stack = {
    repo,
    name,
    ghDir,
    binDir,
    bottomUrl: `https://github.com/se-e2e/${name}/pull/${BOTTOM}`,
    topUrl: `https://github.com/se-e2e/${name}/pull/${TOP}`,
    bottomHead: sha(`${name}:a`),
    topHead: sha(`${name}:b`),
  }
  writeFixture(stack)
  return stack
}

// ── the app ──────────────────────────────────────────────────────────────────

async function launch(stack: Stack): Promise<{ app: ElectronApplication; window: Page }> {
  const root = stack.repo.root
  const env = launchEnv({
    SIMPLEEDIT_REPO: stack.repo.bareRepoPath,
    SIMPLEEDIT_E2E_SCREENPRS_FILTER: path.join(root, 'screenprs-filter.json'),
    SIMPLEEDIT_E2E_REMOTE_CONFIG: path.join(root, 'remote.json'),
    SIMPLEEDIT_E2E_PUSH_CONFIG: path.join(root, 'push.json'),
    SIMPLEEDIT_E2E_PRESENCE_FILE: path.join(root, 'presence'),
    // An idle title, so the delivery core sees the companion as running and idle.
    SIMPLEEDIT_FAKE_CLAUDE_OSC: '1',
    SIMPLEEDIT_FAKE_CLAUDE_COMPANION: '1',
    // Triage runs `claude --print`; without this every PR waits out its timeout.
    SIMPLEEDIT_FAKE_CLAUDE_PRINT_EXIT: '1',
    FAKE_GH_DIR: stack.ghDir,
  })
  env.PATH = `${stack.binDir}${path.delimiter}${env.PATH ?? ''}`
  const app = await electron.launch({ args: [MAIN, ...SANDBOX_ARGS], env })
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  return { app, window }
}

type Api = { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> }

const invoke = (page: Page, channel: string, ...args: unknown[]): Promise<unknown> =>
  page.evaluate(([ch, rest]) => (window as unknown as { api: Api }).api.invoke(ch, ...rest), [channel, args] as const)

async function reviewOf(page: Page, stack: Stack): Promise<Review | undefined> {
  const { reviews } = (await invoke(page, 'review:load')) as ReviewSnapshot
  return reviews
    .filter((review) => review.layers.some((layer) => layer.url === stack.topUrl))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
}

async function draftComments(page: Page, url: string): Promise<PrReviewComment[]> {
  const { drafts } = (await invoke(page, 'screenprs:drafts-load')) as { drafts: Record<string, { comments: PrReviewComment[] } | undefined> }
  return drafts[url]?.comments ?? []
}

/** The app's database is shared by every run: an open review would be swept and listed by the next. */
async function discardReview(page: Page, stack: Stack): Promise<void> {
  try {
    const review = await reviewOf(page, stack)
    if (review?.status === 'open') await invoke(page, 'review:discard', review.id)
  } catch {
    /* best effort: a failed test may have left the window unusable */
  }
}

async function showSessions(page: Page): Promise<Locator> {
  await page.getByRole('region', { name: 'Sessions' }).getByRole('button', { name: /Sessions/ }).first().click()
  return page.getByRole('listbox', { name: 'Sessions' })
}

/** Screen the queue (the fake gh's two PRs) and open the top layer: the room shows the whole stack. */
async function screenAndOpen(page: Page): Promise<void> {
  await waitForWorktreesReady(page)
  await page.getByTitle('Screen your review queue').filter({ visible: true }).first().click()
  await pickTopLayer(page)
}

async function pickTopLayer(page: Page): Promise<void> {
  const card = page.getByTestId('screenprs-queue').getByRole('button', { name: new RegExp(TOP_TITLE) }).first()
  await expect(card).toBeEnabled({ timeout: 30_000 })
  await card.click()
  await expect(page.getByTestId('review-room')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('layer-section')).toHaveCount(2, { timeout: 30_000 })
  await expect(topLayer(page).getByTestId('diff-line-comment').first()).toBeAttached({ timeout: 30_000 })
}

const topLayer = (page: Page): Locator => page.locator(`#layer-${TOP}`)

/** Open the composer on the top layer's line `line` and type `text` into it. */
async function compose(page: Page, line: number, text: string): Promise<Locator> {
  const layer = topLayer(page)
  await layer.getByRole('button', { name: `Comment on line ${line}`, exact: true }).click()
  const composer = layer.getByTestId('thread-composer')
  await composer.getByRole('textbox', { name: 'New thread' }).fill(text)
  return composer
}

/** Ask the companion on the top layer's line `line`; resolves to the new thread's card. */
async function askOnLine(page: Page, line: number, question: string): Promise<Locator> {
  const composer = await compose(page, line, question)
  await composer.getByRole('button', { name: 'Ask companion', exact: true }).click()
  const card = topLayer(page).locator('[data-thread-card]').filter({ hasText: question })
  await expect(card).toBeVisible({ timeout: 10_000 })
  return card
}

/** Start a thread on the top layer's line `line` with the user's own comment and no question. */
async function draftOnLine(page: Page, line: number, comment: string): Promise<void> {
  const composer = await compose(page, line, comment)
  await composer.getByRole('button', { name: 'Draft comment', exact: true }).click()
  await expect(composer).toHaveCount(0, { timeout: 10_000 })
}

const ANSWER = 'Fake companion answer'

const test = base.extend<{ stack: Stack }>({
  stack: async ({}, use, testInfo) => {
    const stack = createStack(`t${testInfo.workerIndex}`)
    await use(stack)
    removeTempRepo(stack.repo)
  },
})

test.skip(process.platform === 'win32', 'The fake gh and claude are POSIX scripts')
test.skip(!hasNode, 'The fake gh and the fake companion run on node, which is not on PATH')

// ── 1. Ask → hidden companion → answer in the thread ────────────────────────

test('asking on a line starts a hidden companion whose answer lands in that thread', async ({ stack }) => {
  test.setTimeout(150_000)
  const { app, window } = await launch(stack)
  try {
    // A session of the user's own, so the Sessions list has something to show besides.
    await spawnClaudeSession(window)
    await screenAndOpen(window)

    await expect(window.getByTestId('companion-status')).toHaveText(/Not started/)
    const card = await askOnLine(window, 3, 'Why is the limit 10?')

    await expect(card.getByTestId('conversation')).toContainText(ANSWER, { timeout: 60_000 })
    // Answered by the companion itself, not attached from the turn's text.
    await expect(card.getByTestId('message').filter({ hasText: ANSWER })).toHaveCount(1)

    const review = await reviewOf(window, stack)
    expect(review?.status).toBe('open')
    expect(review?.layers.map((layer) => layer.number)).toEqual([BOTTOM, TOP])
    const companionId = review?.companion?.sessionId
    expect(companionId).toBeTruthy()
    expect((await invoke(window, 'pty:active-ids')) as string[]).toContain(companionId)

    // Alive, but never listed: only the user's own session is in Sessions.
    const list = await showSessions(window)
    await expect(list.getByRole('option')).toHaveCount(1)
    await expect(sessionOption(window, /Review companion/)).toHaveCount(0)
  } finally {
    await discardReview(window, stack)
    await app.close()
  }
})

// ── 2. Submit per layer, with a reply to an existing GitHub thread ───────────

interface GraphqlCall {
  operation: string | null
  variables: { input?: Record<string, unknown> }
  answer: { data?: { addPullRequestReview?: { pullRequestReview?: { id?: string } } } }
}

function graphqlCalls(stack: Stack): GraphqlCall[] {
  const file = path.join(stack.ghDir, 'log.jsonl')
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { graphql?: GraphqlCall })
    .flatMap((entry) => (entry.graphql ? [entry.graphql] : []))
}

test('submitting posts one GraphQL review per layer, the reply inside its pending review, then clears the drafts', async ({ stack }) => {
  test.setTimeout(150_000)
  writeFixture(stack, { [String(TOP)]: [GITHUB_THREAD] })
  const { app, window } = await launch(stack)
  try {
    await screenAndOpen(window)

    // The imported GitHub thread: a reply drafted on it.
    const githubCard = topLayer(window).locator('[data-thread-card]').filter({ hasText: 'Why is this a constant?' })
    await expect(githubCard).toBeVisible({ timeout: 30_000 })
    await githubCard.getByRole('button', { name: 'Draft reply', exact: true }).click()
    const reply = githubCard.getByRole('textbox', { name: 'Your comment' })
    await reply.fill('Because it is the product limit.')
    await reply.blur()

    // A new line comment of the user's own.
    await draftOnLine(window, 3, 'Name the limit in the call too.')

    await expect
      .poll(async () => (await draftComments(window, stack.topUrl)).map((c) => c.text).sort())
      .toEqual(['Because it is the product limit.', 'Name the limit in the call too.'])

    await window.getByRole('button', { name: 'Submit reviews…' }).click()
    const dialog = window.getByRole('dialog', { name: 'Submit reviews' })
    await dialog.getByRole('radiogroup', { name: `Verdict for #${BOTTOM}` }).getByRole('radio', { name: 'Approve' }).check()
    await dialog.getByRole('radiogroup', { name: `Verdict for #${TOP}` }).getByRole('radio', { name: 'Request changes' }).check()
    await dialog.getByRole('button', { name: 'Submit 2 reviews' }).click()
    const outcomes = dialog.getByTestId('submit-outcome')
    await expect(outcomes).toHaveCount(2, { timeout: 60_000 })
    await expect(outcomes.nth(0)).toContainText('Posted')
    await expect(outcomes.nth(1)).toContainText('Posted')

    const calls = graphqlCalls(stack)
    const index = (call: GraphqlCall): number => calls.indexOf(call)
    const created = calls.filter((c) => c.operation === 'AddReview')
    expect(created).toHaveLength(2)
    const createdOn = (number: number): GraphqlCall => {
      const call = created.find((c) => c.variables.input?.pullRequestId === `PR_e2e_${number}`)
      expect(call, `addPullRequestReview for #${number}`).toBeDefined()
      return call!
    }
    const reviewIdOf = (call: GraphqlCall): string | undefined => call.answer.data?.addPullRequestReview?.pullRequestReview?.id

    // Each layer's review is pinned to the head the user read, with its line threads in the creating call.
    const top = createdOn(TOP)
    expect(top.variables.input?.commitOID).toBe(stack.topHead)
    expect(top.variables.input?.threads).toEqual([
      expect.objectContaining({ path: 'src/stack.ts', line: 3, side: 'RIGHT', body: expect.stringContaining('Name the limit in the call too.') }),
    ])
    const bottom = createdOn(BOTTOM)
    expect(bottom.variables.input?.commitOID).toBe(stack.bottomHead)
    expect(bottom.variables.input?.threads).toEqual([])

    // The reply goes into the top layer's pending review, never straight onto the PR.
    const replies = calls.filter((c) => c.operation === 'AddReply')
    expect(replies).toHaveLength(1)
    expect(replies[0]!.variables.input).toEqual(
      expect.objectContaining({
        pullRequestReviewId: reviewIdOf(top),
        pullRequestReviewThreadId: GITHUB_THREAD.id,
        body: expect.stringContaining('Because it is the product limit.'),
      }),
    )
    expect(index(replies[0]!)).toBeGreaterThan(index(top))

    const submits = calls.filter((c) => c.operation === 'SubmitReview')
    expect(submits).toHaveLength(2)
    const submitOf = (call: GraphqlCall): GraphqlCall | undefined =>
      submits.find((s) => s.variables.input?.pullRequestReviewId === reviewIdOf(call))
    expect(submitOf(top)?.variables.input?.event).toBe('REQUEST_CHANGES')
    expect(submitOf(bottom)?.variables.input?.event).toBe('APPROVE')
    expect(index(submitOf(top)!)).toBeGreaterThan(index(replies[0]!))

    // Posted drafts leave the store, and the review is over.
    await expect.poll(() => draftComments(window, stack.topUrl)).toEqual([])
    await expect.poll(async () => (await reviewOf(window, stack))?.status).toBe('submitted')
    await dialog.getByRole('button', { name: 'Close' }).click()
    await expect(window.getByTestId('review-room')).toContainText('This review was submitted.')
    await expect(window.getByTestId('post-bar')).toContainText(`#${TOP}: 0 to post`)
  } finally {
    await discardReview(window, stack)
    await app.close()
  }
})

// ── 3. Restore: the owned companion comes back as Resume in the dock ─────────

test('after a restart the companion is not in Sessions and the room offers Resume', async ({ stack }) => {
  test.setTimeout(240_000)
  let { app, window } = await launch(stack)
  let closed = false
  try {
    await spawnClaudeSession(window)
    await screenAndOpen(window)
    const card = await askOnLine(window, 3, 'What calls clamp?')
    await expect(card.getByTestId('conversation')).toContainText(ANSWER, { timeout: 60_000 })
    const before = (await reviewOf(window, stack))?.companion?.sessionId
    expect(before).toBeTruthy()
    await window.waitForTimeout(1_500) // the debounced session save (500ms)
    await app.close()
    closed = true

    ;({ app, window } = await launch(stack))
    closed = false
    // Quit is not a session end: the claim survives it.
    await expect.poll(async () => (await reviewOf(window, stack))?.companion?.sessionId, { timeout: 15_000 }).toBe(before)

    const list = await showSessions(window)
    await expect(list.getByRole('option')).toHaveCount(1, { timeout: 15_000 })
    await expect(sessionOption(window, /Review companion/)).toHaveCount(0)

    await window.getByTitle('Screen your review queue').filter({ visible: true }).first().click()
    await pickTopLayer(window)
    const dock = window.getByTestId('companion-dock')
    await expect(dock.getByTestId('companion-status')).toHaveText(/Paused since SimpleEdit restarted/, { timeout: 15_000 })
    const resume = dock.getByRole('button', { name: 'Resume', exact: true })
    await expect(resume).toBeVisible()

    await resume.click()
    await expect(resume).toHaveCount(0, { timeout: 15_000 })
    await expect(dock.getByTestId('companion-status')).toHaveText(/Idle/, { timeout: 30_000 })
    const after = (await reviewOf(window, stack))?.companion?.sessionId
    expect(after).toBeTruthy()
    expect((await invoke(window, 'pty:active-ids')) as string[]).toContain(after)

    // Resumed, and still never listed.
    const again = await showSessions(window)
    await expect(again.getByRole('option')).toHaveCount(1)
    await expect(sessionOption(window, /Review companion/)).toHaveCount(0)
  } finally {
    if (!closed) {
      await discardReview(window, stack)
      await app.close()
    }
  }
})

// ── 4. Two windows, one review, one companion ────────────────────────────────

test('a second window on the same review asks the same companion, whose terminal lives in the first', async ({ stack }) => {
  test.setTimeout(150_000)
  const other = createTempRepo('simpleedit-review-room-second-')
  const { app, window } = await launch(stack)
  try {
    await screenAndOpen(window)
    const first = await askOnLine(window, 3, 'Is LIMIT exported on purpose?')
    await expect(first.getByTestId('conversation')).toContainText(ANSWER, { timeout: 60_000 })
    const companionId = (await reviewOf(window, stack))?.companion?.sessionId
    expect(companionId).toBeTruthy()

    const opened = app.waitForEvent('window')
    await invoke(window, 'app:open-window', other.bareRepoPath)
    const second = await opened
    await second.waitForLoadState('domcontentloaded')
    await waitForWorktreesReady(second)

    // The screening is the app's: the second window shows the same board.
    await second.getByRole('region', { name: 'Screen PRs' }).getByRole('button', { name: /Screen PRs/ }).first().click()
    await pickTopLayer(second)
    const dock = second.getByTestId('companion-dock')
    await expect(dock.getByTestId('companion-status')).toHaveText(/Terminal lives in another window/, { timeout: 15_000 })
    await expect(dock.getByRole('button', { name: /Terminal/ })).toBeDisabled()

    const card = topLayer(second).locator('[data-thread-card]').filter({ hasText: 'Is LIMIT exported on purpose?' })
    await expect(card.getByTestId('message').filter({ hasText: ANSWER })).toHaveCount(1, { timeout: 15_000 })
    await card.getByRole('textbox', { name: 'Ask the companion' }).fill('And who else reads it?')
    await card.getByRole('button', { name: 'Ask', exact: true }).click()
    await expect(card.getByTestId('message').filter({ hasText: ANSWER })).toHaveCount(2, { timeout: 60_000 })
    await expect(first.getByTestId('message').filter({ hasText: ANSWER })).toHaveCount(2, { timeout: 15_000 })

    // Still the one companion, and no second agent was started for it.
    expect((await reviewOf(second, stack))?.companion?.sessionId).toBe(companionId)
    const agents = ((await invoke(second, 'pty:active-ids')) as string[]).filter((id) => id.startsWith('agent-'))
    expect(agents).toEqual([companionId])
  } finally {
    await discardReview(window, stack)
    await app.close()
    removeTempRepo(other)
  }
})
