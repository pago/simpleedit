import { render, screen, fireEvent, waitFor } from '@testing-library/svelte'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import ChangesPane from '../ChangesPane.svelte'
import { nav } from '../lib/nav.svelte'
import type { ConnectionState, RemoteConnection } from '../api-shim'
import type { GitCommitInfo, WindowSession } from '../../shared/ipc-types'

/**
 * The promises this pane makes, not the diff renderer's mechanics —
 * `MobileDiff.test.ts` owns those.
 *
 * What is proved here: it opens where the desk opens, it never renders a diff
 * that was fetched for something else, it can always be got out of an error,
 * and it cannot touch anything that writes.
 */

type Listener = (data: never) => void

let listeners: Map<string, Listener[]>
let calls: { channel: string; args: unknown[] }[]
let stateWatchers: ((state: ConnectionState) => void)[]

/** Deferred answers, so a test can hold a read open across another action. */
let held: Map<string, { resolve: (value: unknown) => void; reject: (err: Error) => void }>
let holdChannels: Set<string>

let commits: GitCommitInfo[]
/** Per-worktree overrides, so a late answer can be told apart from a live one. */
let logsByWorktree: Record<string, GitCommitInfo[]>
let staging: { path: string; status: 'added' | 'modified' | 'deleted' }[]
let diffs: Record<string, string>

const WORKTREE = '/code/simpleedit/feat/pty'
const REPO = '/code/simpleedit/simpleedit.git'
const OTHER_REPO = '/code/other/other.git'

const DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-old
+new
`

const COMMIT_DIFF = `diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -1 +1 @@
-was
+committed
`

function emit(channel: string, data: unknown): void {
  for (const fn of [...(listeners.get(channel) ?? [])]) fn(data as never)
}

const connection: RemoteConnection = {
  state: () => 'open',
  reconnect: () => {},
  identity: () => ({ windowId: 1, clientKey: 'w1.1' }),
  onStateChange: (fn) => {
    stateWatchers.push(fn)
    return () => { stateWatchers = stateWatchers.filter((w) => w !== fn) }
  },
  setKey: () => {},
    onIdentity: () => () => {},
}

/** Drive the shim's state the way a dropped-then-restored socket does. */
function reconnect(): void {
  for (const fn of [...stateWatchers]) fn('closed')
  for (const fn of [...stateWatchers]) fn('open')
}

function session(overrides: Partial<WindowSession> = {}): WindowSession {
  return {
    terminalId: 'agent-claude-1',
    label: 'Fix the parser',
    kind: 'agent',
    provider: 'claude',
    worktreePath: WORKTREE,
    status: 'waiting',
    statusSince: 0,
    trail: [{ repoPath: REPO, worktrees: [WORKTREE, '/code/simpleedit/main'] }],
    ...overrides,
  }
}

function mount(overrides: Partial<WindowSession> = {}, active = true) {
  return render(ChangesPane, { props: { session: session(overrides), connection, active } })
}

/** The shell's back button, which is the only way out of a diff. */
async function back(): Promise<void> {
  nav.back()
  await flush()
}

/**
 * Let every microtask AND Svelte's render flush run.
 *
 * A negative assertion made before the flush passes for the wrong reason: the
 * DOM has simply not caught up yet, and it would go on passing with the guard
 * it is meant to be testing deleted.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20))
}

function commit(hash: string, message: string): GitCommitInfo {
  return { hash, message, author: 'pago', date: new Date().toISOString() }
}

beforeEach(() => {
  nav.reset()
  listeners = new Map()
  calls = []
  stateWatchers = []
  held = new Map()
  holdChannels = new Set()
  commits = [commit('aaa1111', 'Newest commit'), commit('bbb2222', 'Older commit')]
  logsByWorktree = {}
  staging = [{ path: 'src/a.ts', status: 'modified' }]
  diffs = { staging: DIFF, aaa1111: COMMIT_DIFF, bbb2222: COMMIT_DIFF }

  const answer = (channel: string, args: unknown[]): unknown => {
    switch (channel) {
      case 'worktree:list':
        return [
          { path: WORKTREE, branch: 'feat/pty', isMain: false, isCurrent: true },
          { path: '/code/simpleedit/main', branch: 'main', isMain: true, isCurrent: false },
          { path: '/code/simpleedit/spare', branch: 'spare', isMain: false, isCurrent: false },
        ]
      case 'git:log':
        return logsByWorktree[String(args[0])] ?? commits
      case 'git:staging-files':
        return staging
      case 'git:staging-diff':
        return diffs.staging
      case 'git:diff':
        return diffs[String(args[1])] ?? ''
      default:
        throw new Error(`unexpected channel ${channel}`)
    }
  }

  vi.stubGlobal('api', {
    on: (channel: string, cb: Listener) => {
      listeners.set(channel, [...(listeners.get(channel) ?? []), cb])
      return () => listeners.set(channel, (listeners.get(channel) ?? []).filter((fn) => fn !== cb))
    },
    invoke: (channel: string, ...args: unknown[]) => {
      calls.push({ channel, args })
      const key = `${channel}|${args.map(String).join('|')}`
      if (holdChannels.has(channel) || holdChannels.has(key)) {
        return new Promise((resolve, reject) => { held.set(key, { resolve, reject }) })
      }
      try {
        return Promise.resolve(answer(channel, args))
      } catch (err) {
        return Promise.reject(err)
      }
    },
  })
})

describe('ChangesPane', () => {
  it('opens on the session worktree\'s uncommitted changes, as the desk does', async () => {
    mount()
    await waitFor(() => expect(screen.getByText('new')).toBeTruthy())
    expect(screen.getByTestId('entry-title').textContent).toBe('Uncommitted changes')
    expect(screen.getByTestId('session-diff')).toBeTruthy()
    expect((screen.getByTestId('worktree-select') as HTMLSelectElement).value).toBe(WORKTREE)
  })

  it('falls back to the newest commit when the tree is clean', async () => {
    staging = []
    mount()
    await waitFor(() => expect(screen.getByTestId('entry-title').textContent).toBe('Newest commit'))
    expect(calls.some((c) => c.channel === 'git:diff' && c.args[1] === 'aaa1111')).toBe(true)
  })

  it('shows the log when the entry is closed, and opens the commit that is tapped', async () => {
    mount()
    await waitFor(() => expect(screen.getByTestId('entry-title')).toBeTruthy())
    expect(nav.top()).toMatchObject({ kind: 'changes-diff', terminalId: 'agent-claude-1' })
    await back()

    const rows = screen.getAllByTestId('entry-commit')
    expect(rows.map((r) => r.getAttribute('data-hash'))).toEqual(['aaa1111', 'bbb2222'])
    expect(screen.getByTestId('entry-uncommitted')).toBeTruthy()

    await fireEvent.click(rows[1])
    await waitFor(() => expect(screen.getByTestId('entry-title').textContent).toBe('Older commit'))
    expect(calls.some((c) => c.channel === 'git:diff' && c.args[1] === 'bbb2222')).toBe(true)
  })

  // A diff opened behind the terminal would make Back close something unseen.
  it('leaves the log showing when it opens while not on screen', async () => {
    mount({}, false)
    await waitFor(() => expect(screen.getAllByTestId('entry-commit')).toHaveLength(2))
    expect(screen.queryByTestId('entry-title')).toBeNull()
    expect(nav.stack()).toEqual([])
  })

  // The whole surface: five channels, none of which can change anything.
  it('never reaches a channel that could write', async () => {
    mount()
    await waitFor(() => expect(screen.getByTestId('session-diff')).toBeTruthy())
    await back()
    await fireEvent.click(screen.getAllByTestId('entry-commit')[0])
    await fireEvent.change(screen.getByTestId('worktree-select'), {
      target: { value: '/code/simpleedit/spare' },
    })
    await waitFor(() => expect(calls.length).toBeGreaterThan(4))
    expect([...new Set(calls.map((c) => c.channel))].sort()).toEqual([
      'git:diff',
      'git:log',
      'git:staging-diff',
      'git:staging-files',
      'worktree:list',
    ])
  })

  it('offers the session\'s repos and switches the worktree list with them', async () => {
    mount({
      trail: [
        { repoPath: REPO, worktrees: [WORKTREE] },
        { repoPath: OTHER_REPO, worktrees: ['/code/other/wip'] },
      ],
    })
    await waitFor(() => expect(screen.getByTestId('repo-select')).toBeTruthy())
    await fireEvent.change(screen.getByTestId('repo-select'), { target: { value: OTHER_REPO } })
    await waitFor(() =>
      expect((screen.getByTestId('worktree-select') as HTMLSelectElement).value).toBe('/code/other/wip'),
    )
    expect(calls.some((c) => c.channel === 'git:log' && c.args[0] === '/code/other/wip')).toBe(true)
  })

  it('hides the repo picker when the session has only ever been in one repo', async () => {
    mount()
    await waitFor(() => expect(screen.getByTestId('worktree-select')).toBeTruthy())
    expect(screen.queryByTestId('repo-select')).toBeNull()
  })

  it('offers a retry when a diff read fails, and the retry works', async () => {
    holdChannels.add('git:staging-diff')
    mount()
    await waitFor(() => expect(held.get(`git:staging-diff|${WORKTREE}`)).toBeTruthy())
    held.get(`git:staging-diff|${WORKTREE}`)!.reject(new Error('Connection lost'))
    await waitFor(() => expect(screen.getByTestId('diff-error').textContent).toBe('Connection lost'))

    holdChannels.delete('git:staging-diff')
    await fireEvent.click(screen.getByTestId('diff-retry'))
    await waitFor(() => expect(screen.getByText('new')).toBeTruthy())
  })

  /**
   * The bug this exists to prevent: the shim rejects every in-flight call when
   * the socket dies, and its reconnect backoff runs from 500 ms to 10 s. A
   * screen left on an error with only a manual Retry is a screen the user has
   * to poke at random until the invisible timer happens to have fired.
   */
  it('re-runs a read that the dropped socket rejected, when the socket comes back', async () => {
    holdChannels.add('git:staging-diff')
    mount()
    await waitFor(() => expect(held.get(`git:staging-diff|${WORKTREE}`)).toBeTruthy())
    held.get(`git:staging-diff|${WORKTREE}`)!.reject(new Error('Connection lost'))
    await waitFor(() => expect(screen.getByTestId('diff-error')).toBeTruthy())

    holdChannels.delete('git:staging-diff')
    reconnect()
    await waitFor(() => expect(screen.getByText('new')).toBeTruthy())
    expect(screen.queryByTestId('diff-error')).toBeNull()
  })

  it('re-runs a failed log read on reconnect too', async () => {
    holdChannels.add('git:log')
    mount()
    await waitFor(() => expect(held.get(`git:log|${WORKTREE}`)).toBeTruthy())
    held.get(`git:log|${WORKTREE}`)!.reject(new Error('Connection lost'))
    await waitFor(() => expect(screen.getByTestId('log-error')).toBeTruthy())

    holdChannels.delete('git:log')
    reconnect()
    await waitFor(() => expect(screen.getByTestId('entry-title').textContent).toBe('Uncommitted changes'))
  })

  // A gap of unknown length means what is on screen may be from before it —
  // said out loud rather than silently swapped or silently trusted.
  it('calls a snapshot that survived a reconnect stale rather than refetching it', async () => {
    mount()
    await waitFor(() => expect(screen.getByTestId('session-diff')).toBeTruthy())
    const before = calls.length
    reconnect()
    await waitFor(() => expect(screen.getByTestId('stale-reload')).toBeTruthy())
    expect(calls.length).toBe(before)

    diffs.staging = DIFF.replace('+new', '+reloaded')
    await fireEvent.click(screen.getByTestId('stale-reload'))
    await waitFor(() => expect(screen.getByText('reloaded')).toBeTruthy())
    expect(screen.queryByTestId('stale-reload')).toBeNull()
  })

  it('marks a snapshot stale when its own worktree changes, and ignores another\'s', async () => {
    mount()
    await waitFor(() => expect(screen.getByTestId('session-diff')).toBeTruthy())

    emit('git:status-changed', { worktreePath: '/code/simpleedit/main' })
    await flush()
    expect(screen.queryByTestId('stale-reload')).toBeNull()

    emit('git:refs-changed', { worktreePath: WORKTREE })
    await waitFor(() => expect(screen.getByTestId('stale-reload')).toBeTruthy())
  })

  /**
   * Tapping through commits on a slow link must not end with the first one's
   * diff under the last one's title.
   */
  it('discards a superseded diff rather than rendering it under the wrong title', async () => {
    staging = []
    holdChannels.add(`git:diff|${WORKTREE}|aaa1111`)
    mount()
    await waitFor(() => expect(held.get(`git:diff|${WORKTREE}|aaa1111`)).toBeTruthy())

    await back()
    await fireEvent.click(screen.getAllByTestId('entry-commit')[1])
    await waitFor(() => expect(screen.getByTestId('entry-title').textContent).toBe('Older commit'))

    await waitFor(() => expect(screen.getByText('committed')).toBeTruthy())

    // The abandoned read finally answers, with content of its own.
    held.get(`git:diff|${WORKTREE}|aaa1111`)!.resolve(COMMIT_DIFF.replace('+committed', '+stale answer'))
    await flush()
    expect(screen.queryByText('stale answer')).toBeNull()
    expect(screen.getByText('committed')).toBeTruthy()
    expect(screen.getByTestId('entry-title').textContent).toBe('Older commit')
  })

  // The same rule one level up: switching worktrees while a log is in flight
  // must not end with the old worktree's commits under the new one's name.
  it('discards a superseded log read', async () => {
    staging = []
    const SPARE = '/code/simpleedit/spare'
    logsByWorktree[SPARE] = [commit('ccc3333', 'Spare commit')]
    holdChannels.add('git:log')
    mount()
    await waitFor(() => expect(held.get(`git:log|${WORKTREE}`)).toBeTruthy())

    holdChannels.delete('git:log')
    // The spare worktree only becomes an option once `worktree:list` answers.
    await waitFor(() =>
      expect(screen.getByTestId('worktree-select').querySelector(`option[value="${SPARE}"]`)).toBeTruthy(),
    )
    await fireEvent.change(screen.getByTestId('worktree-select'), { target: { value: SPARE } })
    await waitFor(() => expect(screen.getByTestId('entry-title').textContent).toBe('Spare commit'))

    held.get(`git:log|${WORKTREE}`)!.resolve(commits)
    await flush()
    expect(screen.getByTestId('entry-title').textContent).toBe('Spare commit')
    await back()
    expect(screen.getAllByTestId('entry-commit').map((r) => r.getAttribute('data-hash'))).toEqual(['ccc3333'])
  })

  // `git diff HEAD` cannot see a file git has never been told about.
  it('names untracked files instead of showing a blank pane', async () => {
    staging = [{ path: 'src/new.ts', status: 'added' }]
    diffs.staging = ''
    mount()
    await waitFor(() => expect(screen.getByTestId('untracked-note')).toBeTruthy())
    expect(screen.getByText('src/new.ts')).toBeTruthy()
  })

  it('says a worktree has nothing to review rather than showing an empty list', async () => {
    staging = []
    commits = []
    mount()
    await waitFor(() => expect(screen.getByText(/Nothing to review/)).toBeTruthy())
  })
})
