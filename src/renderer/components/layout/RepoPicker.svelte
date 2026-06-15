<script lang="ts">
  import {
    sessionsStore,
    touchedReposForSession,
    touchedWorktreesForRepo,
  } from '../../stores/sessions.svelte'
  import {
    primaryRepo,
    mainWorktreeFor,
    refreshWorktreesFor,
    repoKeyForWorktree,
  } from '../../stores/worktrees.svelte'

  interface Props {
    /** Bare repo the workspace is currently scoped to (undefined = primary). */
    repoPath?: string
    /** Open the native dialog to view a repo the agent hasn't roamed into. */
    onpickother: () => void
  }

  let { repoPath, onpickother }: Props = $props()

  let open = $state(false)
  let buttonEl = $state<HTMLButtonElement | undefined>()
  let popoverEl = $state<HTMLElement | null>(null)

  let activeSession = $derived(sessionsStore.activeSession())

  // Repos this agent has worked across, most-recent first. The currently
  // viewed repo is always among them (the trail is seeded with the session's
  // initial worktree).
  let repos = $derived(activeSession ? touchedReposForSession(activeSession) : [])

  let currentRepo = $derived(repoPath ?? primaryRepo())
  // The repo the agent is currently in — drives the "over here" dot when you're
  // viewing a different repo than the agent is working in.
  let agentRepo = $derived(
    activeSession ? repoKeyForWorktree(activeSession.touchedWorktrees[0] ?? '') : null,
  )

  function repoName(repo: string): string {
    return repo.replace(/\/[^/]*\.git$/, '').split('/').pop() ?? '—'
  }

  let currentLabel = $derived(currentRepo ? repoName(currentRepo) : '—')

  async function selectRepo(repo: string): Promise<void> {
    open = false
    const session = sessionsStore.activeSession()
    if (!session) return
    const repoArg = repo === primaryRepo() ? undefined : repo
    // Land on the worktree the agent last touched in this repo; fall back to
    // its main worktree when the repo was opened manually but never worked in.
    const touched = touchedWorktreesForRepo(session, repo)
    if (touched[0]) {
      sessionsStore.setActiveSessionWorktree(touched[0], repoArg)
      return
    }
    await refreshWorktreesFor(repo)
    const main = mainWorktreeFor(repo)
    if (main) sessionsStore.setActiveSessionWorktree(main.path, repoArg)
  }

  function handleWindowPointerDown(e: PointerEvent): void {
    if (!open) return
    const target = e.target as Node
    if (popoverEl?.contains(target) || buttonEl?.contains(target)) return
    open = false
  }

  function handleWindowKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape' && open) {
      open = false
      buttonEl?.focus()
    }
  }
</script>

<svelte:window onpointerdown={handleWindowPointerDown} onkeydown={handleWindowKeydown} />

<div class="relative">
  <button
    bind:this={buttonEl}
    class="max-w-[160px] truncate rounded px-1.5 py-0.5 text-[11px] font-medium text-zinc-500 hover:bg-zinc-700 hover:text-zinc-200"
    onclick={() => (open = !open)}
    aria-haspopup="menu"
    aria-expanded={open}
    title="Repository this workspace is viewing — switch between the repos this agent has worked in"
  >
    {currentLabel} ▾
  </button>

  {#if open}
    <div
      bind:this={popoverEl}
      class="absolute right-0 top-full z-30 mt-1 w-56 overflow-hidden rounded border border-zinc-700 bg-zinc-900 py-1 shadow-xl"
      role="menu"
      aria-label="Repositories"
    >
      {#each repos as repo (repo)}
        {@const isCurrent = repo === currentRepo}
        {@const isAgentHere = repo === agentRepo && repo !== currentRepo}
        <button
          class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] {isCurrent
            ? 'bg-zinc-700 text-zinc-100'
            : 'text-zinc-300 hover:bg-zinc-800'}"
          role="menuitem"
          onclick={() => selectRepo(repo)}
        >
          <span
            class="h-2 w-2 shrink-0 rounded-full {isCurrent
              ? 'bg-green-400'
              : isAgentHere
                ? 'bg-amber-400'
                : 'bg-zinc-600'}"
            title={isAgentHere ? 'Agent is working in this repo' : undefined}
          ></span>
          <span class="flex-1 truncate" title={repo}>{repoName(repo)}</span>
        </button>
      {/each}

      <div class="my-1 border-t border-zinc-800" role="separator"></div>

      <button
        class="w-full px-3 py-1.5 text-left text-[11px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
        role="menuitem"
        onclick={() => {
          open = false
          onpickother()
        }}
      >
        Open another repo…
      </button>
    </div>
  {/if}
</div>
