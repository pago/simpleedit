<script lang="ts">
  /**
   * What the agent changed: repo → worktree → commit, and the diff.
   *
   * The navigation is the desktop's, not a second model of it. The repo and
   * worktree pickers read the session's own trail (`SessionRepoTrail`, the same
   * one `RepoPicker` renders), the log is `git:log`, and a worktree opens on
   * its uncommitted changes exactly as it does at the desk.
   *
   * A diff on screen is a `changes-diff` entry on the navigation stack, so the
   * shell's back button and the system Back gesture are how you return to the
   * log — there is no second back button in here. It is only pushed while this
   * pane is `active`: a diff opened behind the terminal, or behind another
   * screen, would be a Back that closes something nobody can see. An automatic
   * open that lands then just leaves the log showing.
   *
   * ── Read, don't write ───────────────────────────────────────────────────
   * Every call goes through `read`, whose type admits five channels, all of
   * which only ever read. That is the enforcement; the paragraph is just the
   * reason. There is no comment, no approval, no staging and no commit on this
   * surface — those need a keyboard and a second screen.
   *
   * ── A diff's lifetime is its screen's ───────────────────────────────────
   * Nothing here is cached. A diff is fetched when its entry is opened and
   * dropped when the entry, the worktree, the repo or the pane goes away, so a
   * diff on screen is one that was fetched for what is on screen. Two
   * consequences fall out of that and both are load-bearing:
   *
   *  - Every fetch carries a sequence number and a late answer to a superseded
   *    one is discarded. Tapping through three commits on a slow link must not
   *    end with the first one's diff under the third one's title.
   *  - A read rejected while the socket is down leaves an error with nothing to
   *    re-run it, because the shim's backoff runs from 500 ms to 10 s and the
   *    user has no way to know when to press Retry. So a failed read is re-run
   *    when the connection comes back, the same way `MobileTerminal` resyncs on
   *    `open`. Retry stays, for the failures that are not the connection's.
   *
   * What it shows is a SNAPSHOT, and it says so rather than swapping content
   * under a reader's thumb: a reconnect, or a git event for the worktree in
   * view, marks it stale and offers a reload. It does not call `git:watch` —
   * that map is keyed by worktree path for the whole app and `git:unwatch` is
   * global, so a phone unsubscribing would tear down the desktop's watch on
   * that worktree. Passive listening costs nobody anything; the reload button
   * is what makes the staleness recoverable either way.
   */
  import { onMount, untrack } from 'svelte'
  import MobileDiff from './MobileDiff.svelte'
  import { nav } from './lib/nav.svelte'
  import {
    defaultEntry,
    entryTitle,
    relativeTime,
    repoChoices,
    repoForWorktree,
    sameEntry,
    shortHash,
    trailWorktrees,
    worktreeChoices,
    type ReviewEntry,
  } from './lib/review'
  import { DIFF_TRUNCATED_MARKER } from '../shared/ipc-types'
  import type { RemoteConnection } from './api-shim'
  import type {
    DiffFileEntry,
    GitCommitInfo,
    InvokeMap,
    WindowSession,
    WorktreeInfo,
  } from '../shared/ipc-types'

  interface Props {
    session: WindowSession
    connection: RemoteConnection
    /** This pane is what the phone is showing. */
    active?: boolean
  }

  let { session, connection, active = true }: Props = $props()

  /**
   * The channels this pane may speak. All five only read; naming them in a type
   * is what stops a later edit from reaching for `git:stage` or `worktree:remove`
   * because it was the nearest thing to hand.
   */
  type ReadChannel = 'worktree:list' | 'git:log' | 'git:staging-files' | 'git:staging-diff' | 'git:diff'

  function read<K extends ReadChannel>(
    channel: K,
    ...args: InvokeMap[K]['args']
  ): Promise<InvokeMap[K]['result']> {
    return window.api.invoke(channel, ...args)
  }

  const trail = $derived(session.trail)
  const repos = $derived(repoChoices(trail))

  /**
   * The selection is the USER's from the first tap on.
   *
   * Seeded from the session and then left alone: the agent moving to another
   * worktree while someone is reading a diff must not move the page under
   * them. New places the agent visits still show up — they arrive as options,
   * not as a jump.
   */
  let repoPath = $state<string | null>(null)
  let worktreePath = $state<string | null>(null)

  let listed = $state<WorktreeInfo[]>([])
  let commits = $state<GitCommitInfo[]>([])
  let stagingFiles = $state<DiffFileEntry[]>([])
  let logLoading = $state(false)
  let logError = $state<string | null>(null)

  let entry = $state<ReviewEntry | null>(null)
  let diff = $state<string | null>(null)
  let diffLoading = $state(false)
  let diffError = $state<string | null>(null)

  /** Something changed under the snapshot on screen, or may have. */
  let stale = $state(false)
  let now = $state(Date.now())

  // Superseded answers are dropped, never rendered. One counter per fetch that
  // can be in flight independently.
  let treeSeq = 0
  let logSeq = 0
  let diffSeq = 0

  /**
   * What the reconnect handler has already re-tried on its own, so it never
   * re-tries the same read twice.
   *
   * Keyed by what is being read rather than by a bare flag: moving to another
   * worktree or another commit is a different read and deserves its own
   * automatic attempt. A manual Retry clears it — that is the user asking for
   * exactly one more, which is a decision rather than a loop.
   */
  let retriedLog: string | null = null
  let retriedDiff: string | null = null

  /** Identity of a diff read: the pair that decides what is fetched. */
  function entryKey(worktree: string | null, target: ReviewEntry | null): string {
    if (worktree === null || target === null) return ''
    return `${worktree}\u0000${target.kind}\u0000${target.kind === 'commit' ? target.hash : ''}`
  }

  const worktrees = $derived(worktreeChoices(trailWorktrees(trail, repoPath), listed))
  /** Main cut this diff short for the transport, and said so inside it. */
  const truncated = $derived(diff !== null && diff.includes(DIFF_TRUNCATED_MARKER))
  const hasUncommitted = $derived(stagingFiles.length > 0)

  function fail(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
  }

  async function loadWorktrees(repo: string | null): Promise<void> {
    if (repo === null) return
    const mine = ++treeSeq
    // `worktree:list` answers `[]` rather than throwing, so there is nothing to
    // report here — the trail keeps the picker usable on its own.
    const next = await read('worktree:list', repo).catch(() => [] as WorktreeInfo[])
    if (mine !== treeSeq) return
    listed = next
  }

  /**
   * The worktree's log and whether its tree is dirty, then the entry it opens
   * on. Both reads are needed before anything can be shown, so they fail and
   * retry together.
   */
  async function loadLog(worktree: string | null, opening: boolean): Promise<void> {
    if (worktree === null) return
    const mine = ++logSeq
    logLoading = true
    logError = null
    try {
      const [log, staging] = await Promise.all([
        read('git:log', worktree),
        read('git:staging-files', worktree),
      ])
      if (mine !== logSeq) return
      commits = log
      stagingFiles = staging
      if (opening) openEntry(defaultEntry(staging.length > 0, log))
    } catch (err) {
      if (mine !== logSeq) return
      logError = fail(err)
      commits = []
      stagingFiles = []
      // What it was going to open is not coming; the error is shown in the log.
      if (opening) openEntry(null)
    } finally {
      if (mine === logSeq) logLoading = false
    }
  }

  async function loadDiff(worktree: string | null, target: ReviewEntry | null): Promise<void> {
    const mine = ++diffSeq
    if (worktree === null || target === null) {
      diff = null
      diffLoading = false
      diffError = null
      return
    }
    diffLoading = true
    diffError = null
    try {
      const next =
        target.kind === 'uncommitted'
          ? await read('git:staging-diff', worktree)
          : await read('git:diff', worktree, target.hash)
      if (mine !== diffSeq) return
      diff = next
    } catch (err) {
      if (mine !== diffSeq) return
      diff = null
      diffError = fail(err)
    } finally {
      if (mine === diffSeq) diffLoading = false
    }
  }

  /** The one commit shape the list and the diff both address. */
  function commitEntry(commit: GitCommitInfo): ReviewEntry {
    return {
      kind: 'commit',
      hash: commit.hash,
      message: commit.message,
      author: commit.author,
      date: commit.date,
    }
  }

  const diffEntry = $derived(
    nav.stack('sessions').find((e) => e.kind === 'changes-diff' && e.terminalId === session.terminalId) ??
      null,
  )

  function openEntry(target: ReviewEntry | null): void {
    if (target === null) {
      nav.close(diffEntry?.id ?? null)
      return
    }
    if (!diffEntry) {
      if (!active) return
      nav.push({ kind: 'changes-diff', terminalId: session.terminalId })
    }
    entry = target
    void loadDiff(worktreePath, target)
  }

  // Popped — by Back, or by leaving the pane. Back to the log.
  $effect(() => {
    if (diffEntry) return
    untrack(() => {
      if (entry !== null) dropEntry()
    })
  })

  function dropEntry(): void {
    entry = null
    // The diff dies with the screen that showed it; a return trip re-reads.
    diff = null
    diffError = null
    diffSeq++
  }

  function selectRepo(repo: string): void {
    if (repo === repoPath) return
    repoPath = repo
    listed = []
    const first = trailWorktrees(trail, repo)[0] ?? null
    selectWorktree(first)
    void loadWorktrees(repo)
  }

  function selectWorktree(chosen: string | null): void {
    // A `<select>` whose options have not arrived yet reports `''`, not null.
    // Reading git at the empty path is a call that can only fail.
    const worktree = chosen || null
    worktreePath = worktree
    commits = []
    stagingFiles = []
    stale = false
    entry = null
    diff = null
    diffError = null
    diffSeq++
    void loadLog(worktree, true)
  }

  function reload(): void {
    stale = false
    void loadLog(worktreePath, false)
    void loadDiff(worktreePath, entry)
  }

  onMount(() => {
    const seedRepo = repoForWorktree(trail, session.worktreePath) ?? trail[0]?.repoPath ?? null
    repoPath = seedRepo
    worktreePath = session.worktreePath
    void loadWorktrees(seedRepo)
    void loadLog(session.worktreePath, true)

    const timer = setInterval(() => { now = Date.now() }, 30_000)

    // The worktree in view moved. Say so; do not swap it under the reader.
    const markStale = ({ worktreePath: changed }: { worktreePath: string }): void => {
      if (changed === worktreePath) stale = true
    }
    const offRefs = window.api.on('git:refs-changed', markStale)
    const offStatus = window.api.on('git:status-changed', markStale)

    // A read that was rejected by the socket dying has no other way back: the
    // reconnect backoff is between half a second and ten, and the user cannot
    // see it. Anything that survived the gap is a snapshot from before it.
    //
    // ONE automatic attempt per thing being read, though. If the read is what
    // KILLED the socket — a reply too large for it to buffer — then re-issuing
    // it on reconnect kills the socket again, forever, with the phone showing
    // a spinner and no way to tell why. Retry stays for the second attempt,
    // because that one is the user's decision rather than a loop.
    let wasOpen = connection.state() === 'open'
    const offState = connection.onStateChange((state) => {
      const isOpen = state === 'open'
      if (isOpen && !wasOpen) {
        const retryLog = logError !== null && retriedLog !== worktreePath
        const diffKey = entryKey(worktreePath, entry)
        const retryDiff = diffError !== null && retriedDiff !== diffKey
        if (retryLog) {
          retriedLog = worktreePath
          void loadLog(worktreePath, entry === null)
        }
        if (retryDiff) {
          retriedDiff = diffKey
          void loadDiff(worktreePath, entry)
        }
        if (logError === null && diffError === null) stale = true
      }
      wasOpen = isOpen
    })

    return () => {
      clearInterval(timer)
      offRefs()
      offStatus()
      offState()
    }
  })
</script>

<div class="flex h-full min-h-0 flex-col" data-testid="changes-pane">
  <div class="flex flex-none items-center gap-2 border-b border-zinc-800 px-3 py-2">
    {#if repos.length > 1}
      <label class="min-w-0 flex-1">
        <span class="sr-only">Repository</span>
        <select
          data-testid="repo-select"
          value={repoPath ?? ''}
          onchange={(e) => selectRepo(e.currentTarget.value)}
          class="w-full truncate rounded border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-200"
        >
          {#each repos as repo (repo.repoPath)}
            <option value={repo.repoPath}>{repo.name}</option>
          {/each}
        </select>
      </label>
    {/if}
    <label class="min-w-0 flex-[2]">
      <span class="sr-only">Worktree</span>
      <select
        data-testid="worktree-select"
        value={worktreePath ?? ''}
        onchange={(e) => selectWorktree(e.currentTarget.value)}
        class="w-full truncate rounded border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-200"
      >
        {#each worktrees as worktree (worktree.path)}
          <option value={worktree.path}>{worktree.touched ? '● ' : ''}{worktree.name}</option>
        {/each}
      </select>
    </label>
  </div>

  {#if stale}
    <button
      type="button"
      onclick={reload}
      data-testid="stale-reload"
      class="flex-none border-b border-amber-900/60 bg-amber-950/30 px-3 py-1.5 text-left text-[11px] text-amber-300"
      >This worktree has changed since it was read. Tap to reload.</button
    >
  {/if}

  {#if entry && diffEntry}
    <div class="flex flex-none items-center gap-2 border-b border-zinc-800 px-3 py-1.5">
      <span class="min-w-0 flex-1 truncate text-xs text-zinc-300" data-testid="entry-title"
        >{entryTitle(entry)}</span
      >
      {#if entry.kind === 'commit'}
        <span class="flex-none font-mono text-[10px] text-zinc-600">{shortHash(entry.hash)}</span>
      {/if}
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto">
      {#if diffLoading}
        <p class="px-4 py-6 text-sm text-zinc-500">Loading the diff…</p>
      {:else if diffError}
        <div class="m-3 rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-300">
          <p class="leading-relaxed" data-testid="diff-error">{diffError}</p>
          <button
            type="button"
            onclick={() => { retriedDiff = null; void loadDiff(worktreePath, entry) }}
            data-testid="diff-retry"
            class="mt-1 underline">Retry</button
          >
        </div>
      {:else if diff !== null}
        {#if truncated}
          <!-- Main bounds a diff for a socket: an oversized reply does not
               arrive slowly, it disconnects the client. Said plainly, because
               a diff that stops halfway with no explanation reads as a bug. -->
          <div
            class="m-3 rounded-md border border-amber-900/60 bg-amber-950/30 px-3 py-2.5 text-xs leading-relaxed text-amber-300"
            data-testid="diff-truncated"
          >
            This diff is too large to send to a phone. What follows is the start
            of it — open the commit at the desk to read the rest.
          </div>
        {/if}
        {#if diff.trim() === '' && entry.kind === 'uncommitted' && stagingFiles.length > 0}
          <!-- `git diff HEAD` cannot see a file git has never been told about,
               so a worktree whose only changes are new files reads as empty.
               Name them rather than showing a blank pane. -->
          <div class="m-3 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2.5 text-xs text-zinc-400">
            <p class="leading-relaxed" data-testid="untracked-note">
              {stagingFiles.length}
              {stagingFiles.length === 1 ? 'file has' : 'files have'} changed, but none of it is tracked
              yet — new files carry no diff until they are added.
            </p>
            <ul class="mt-1.5 space-y-0.5 font-mono text-[11px] text-zinc-500">
              {#each stagingFiles as file (file.path)}
                <li class="truncate">{file.path}</li>
              {/each}
            </ul>
          </div>
        {:else}
          <MobileDiff {diff} />
        {/if}
      {/if}
    </div>
  {:else}
    <div class="min-h-0 flex-1 overflow-y-auto px-3 py-3">
      {#if logError}
        <div class="rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-300">
          <p class="leading-relaxed" data-testid="log-error">{logError}</p>
          <button
            type="button"
            onclick={() => { retriedLog = null; void loadLog(worktreePath, true) }}
            data-testid="log-retry"
            class="mt-1 underline">Retry</button
          >
        </div>
      {:else if logLoading}
        <p class="px-1 py-6 text-sm text-zinc-500">Loading changes…</p>
      {:else}
        <ul class="space-y-1.5">
          {#if hasUncommitted}
            <li>
              <button
                type="button"
                onclick={() => openEntry({ kind: 'uncommitted' })}
                data-testid="entry-uncommitted"
                class="flex w-full items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-3
                       text-left active:bg-zinc-800"
              >
                <span class="min-w-0 flex-1 truncate text-sm text-amber-300">Uncommitted changes</span>
                <span class="flex-none text-[11px] text-zinc-500">{stagingFiles.length}</span>
              </button>
            </li>
          {/if}
          {#each commits as commit (commit.hash)}
            {@const target = commitEntry(commit)}
            <li>
              <button
                type="button"
                onclick={() => openEntry(target)}
                data-testid="entry-commit"
                data-hash={commit.hash}
                class="flex w-full items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-3
                       text-left active:bg-zinc-800 {sameEntry(entry, target) ? 'border-zinc-600' : ''}"
              >
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-sm text-zinc-100">{entryTitle(target)}</span>
                  <span class="block truncate text-[11px] text-zinc-500"
                    >{commit.author} · {relativeTime(commit.date, now)}</span
                  >
                </span>
                <span class="flex-none font-mono text-[10px] text-zinc-600">{shortHash(commit.hash)}</span>
              </button>
            </li>
          {/each}
          {#if !hasUncommitted && commits.length === 0}
            <li class="px-1 py-6 text-sm leading-relaxed text-zinc-500">
              Nothing to review in this worktree yet.
            </li>
          {/if}
        </ul>
      {/if}
    </div>
  {/if}
</div>
