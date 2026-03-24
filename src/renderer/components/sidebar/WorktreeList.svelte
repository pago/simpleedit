<script lang="ts">
  import { onMount } from 'svelte'
  import type { WorktreeInfo } from '../../../shared/ipc-types'
  import {
    worktreeList,
    activeWorktree,
    setActiveWorktree,
    refreshWorktrees
  } from '../../stores/worktrees.svelte'
  import { getClaudeStatus } from '../../stores/claude-status.svelte'

  let creating = $state(false)
  let newName = $state('')
  let removing = $state<string | null>(null)

  onMount(() => {
    refreshWorktrees()
  })

  function handleSelect(worktree: WorktreeInfo): void {
    setActiveWorktree(worktree)
  }

  async function handleCreate(): Promise<void> {
    const name = newName.trim()
    if (!name) return
    await window.api.invoke('worktree:create', name)
    newName = ''
    creating = false
    await refreshWorktrees()
  }

  async function handleRemove(worktreePath: string): Promise<void> {
    await window.api.invoke('worktree:remove', worktreePath)
    removing = null
    await refreshWorktrees()
  }

  function cancelCreate(): void {
    creating = false
    newName = ''
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      handleCreate()
    } else if (e.key === 'Escape') {
      cancelCreate()
    }
  }
</script>

<div class="flex flex-col gap-1">
  <div class="flex items-center justify-between px-1">
    <span class="text-xs font-medium uppercase tracking-wider text-zinc-400">Worktrees</span>
    <button
      class="rounded px-1.5 py-0.5 text-xs text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
      onclick={() => (creating = true)}
    >
      + New
    </button>
  </div>

  {#if creating}
    <div
      class="flex gap-1 px-1"
      onfocusout={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          cancelCreate()
        }
      }}
    >
      <!-- svelte-ignore a11y_autofocus -->
      <input
        class="flex-1 rounded border border-zinc-600 bg-zinc-800 px-2 py-1 text-xs text-zinc-200 outline-none focus:border-blue-500"
        type="text"
        placeholder="branch-name"
        bind:value={newName}
        onkeydown={handleKeydown}
        autofocus
      />
      <button
        class="rounded bg-blue-600 px-2 py-1 text-xs text-white hover:bg-blue-500"
        onclick={handleCreate}
      >
        Create
      </button>
    </div>
  {/if}

  <div class="flex flex-col" role="listbox" aria-label="Worktrees">
    {#each worktreeList() as worktree (worktree.path)}
      {@const isActive = activeWorktree()?.path === worktree.path}
      <div
        class="group flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm {isActive
          ? 'bg-zinc-700 text-zinc-100'
          : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'}"
        role="option"
        aria-selected={isActive}
        tabindex="0"
        onclick={() => handleSelect(worktree)}
        onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleSelect(worktree) }}
      >
        <span
          class="h-2 w-2 shrink-0 rounded-full {isActive ? 'bg-green-400' : 'bg-zinc-600'}"
        ></span>
        <span class="flex-1 truncate">{worktree.branch}</span>
        <span
          class="text-[10px] {getClaudeStatus(worktree.path) === 'running'
            ? 'text-yellow-400'
            : getClaudeStatus(worktree.path) === 'error'
              ? 'text-red-400'
              : getClaudeStatus(worktree.path) === 'waiting'
                ? 'text-blue-400'
                : 'text-zinc-500'}"
        >{getClaudeStatus(worktree.path)}</span>

        {#if !worktree.isMain}
          {#if removing === worktree.path}
            <button
              class="shrink-0 rounded bg-red-600 px-1.5 py-0.5 text-[10px] text-white hover:bg-red-500"
              onclick={(e) => {
                e.stopPropagation()
                handleRemove(worktree.path)
              }}
            >
              Confirm
            </button>
            <button
              class="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-zinc-400 hover:text-zinc-200"
              onclick={(e) => {
                e.stopPropagation()
                removing = null
              }}
            >
              Cancel
            </button>
          {:else}
            <button
              class="shrink-0 rounded px-1 py-0.5 text-[10px] text-zinc-500 opacity-0 hover:text-red-400 group-hover:opacity-100"
              onclick={(e) => {
                e.stopPropagation()
                removing = worktree.path
              }}
            >
              Remove
            </button>
          {/if}
        {/if}
      </div>
    {/each}
  </div>

  {#if worktreeList().length === 0}
    <p class="px-2 text-xs text-zinc-500">No worktrees found</p>
  {/if}
</div>
