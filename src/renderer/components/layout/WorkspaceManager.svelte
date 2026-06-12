<script lang="ts">
  import SessionWorkspace from './SessionWorkspace.svelte'
  import { sessionsStore } from '../../stores/sessions.svelte'
  import { worktreeList, projectRoot, mainWorktree } from '../../stores/worktrees.svelte'

  let activeId = $derived(sessionsStore.activeSessionId())
  // Keep every visited workspace alive (hidden, not destroyed) so switching
  // sessions never loses editor tabs, scroll positions, or the xterm buffer.
  let visitedIds = $derived(sessionsStore.visitedIds())

  /** Claude sessions launch at the PROJECT ROOT (one Claude memory for all
   * work); the workspace viewer defaults to the main worktree. Terminals are
   * working-tree tools, so they launch in the main worktree itself. */
  function startClaude(): void {
    const wt = mainWorktree()
    const root = projectRoot() ?? wt?.path
    if (root && wt) sessionsStore.createClaude(root, wt.path)
  }

  function startAgents(): void {
    const wt = mainWorktree()
    const root = projectRoot() ?? wt?.path
    if (root && wt) sessionsStore.createAgents(root, wt.path)
  }

  function startTerminal(): void {
    const wt = mainWorktree()
    if (wt) sessionsStore.createTerminal(wt.path)
  }
</script>

<div class="h-full">
  {#if sessionsStore.sessions().length === 0}
    <!-- New-session panel: what you see when a project is freshly opened. -->
    <div class="flex h-full flex-col items-center justify-center gap-4">
      <p class="text-sm text-zinc-500">Start a session to get going</p>
      <div class="flex items-center gap-2">
        <button
          class="rounded border border-orange-500/40 bg-orange-500/10 px-4 py-1.5 text-sm text-orange-300 hover:bg-orange-500/20 disabled:opacity-50"
          onclick={startClaude}
          disabled={worktreeList().length === 0}
        >
          ✦ New Claude session
        </button>
        <button
          class="rounded border border-orange-500/20 bg-orange-500/5 px-4 py-1.5 text-sm text-orange-300/80 hover:bg-orange-500/15 disabled:opacity-50"
          onclick={startAgents}
          disabled={worktreeList().length === 0}
        >
          ✦ Agent View
        </button>
        <button
          class="rounded border border-zinc-700 px-4 py-1.5 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-50"
          onclick={startTerminal}
          disabled={worktreeList().length === 0}
        >
          $ Terminal
        </button>
      </div>
    </div>
  {:else}
    {#each visitedIds as id (id)}
      <div class="h-full" class:hidden={id !== activeId}>
        <SessionWorkspace sessionId={id} />
      </div>
    {/each}
    {#if !activeId}
      <div class="flex h-full items-center justify-center">
        <p class="text-sm text-zinc-600">Select a session from the sidebar</p>
      </div>
    {/if}
  {/if}
</div>
