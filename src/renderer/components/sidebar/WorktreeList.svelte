<script lang="ts">
  import { onMount, tick } from 'svelte'
  import type { WorktreeInfo } from '../../../shared/ipc-types'
  import {
    worktreeList,
    activeWorktree,
    setActiveWorktree,
    refreshWorktrees
  } from '../../stores/worktrees.svelte'
  import { getClaudeStatus } from '../../stores/claude-status.svelte'

  type CreateMode = 'new' | 'checkout'

  let creating = $state(false)
  let createMode = $state<CreateMode>('new')
  let newName = $state('')
  let selectedBranch = $state('')
  let availableBranches = $state<string[]>([])
  let branchFilter = $state('')
  let removing = $state<string | null>(null)
  let nameInput = $state<HTMLInputElement | null>(null)
  let busy = $state(false)
  let errorMsg = $state('')

  /** Strip characters illegal in git branch names (see git-check-ref-format). */
  function sanitizeBranchName(input: string): string {
    return input
      .replace(/[\s~^:?*[\]\\@{]/g, '') // illegal characters
      .replace(/\.\./g, '.')             // no consecutive dots
      .replace(/\/\//g, '/')             // no consecutive slashes
      .replace(/\.lock(\/|$)/g, '$1')    // no .lock component
      .replace(/^[./]/, '')              // cannot start with . or /
  }

  function handleNameInput(e: Event): void {
    const input = e.target as HTMLInputElement
    const sanitized = sanitizeBranchName(input.value)
    if (sanitized !== input.value) {
      input.value = sanitized
    }
    newName = sanitized
  }

  let isValidName = $derived(newName.trim().length > 0 && !newName.endsWith('.') && !newName.endsWith('/'))

  let filteredBranches = $derived(
    branchFilter
      ? availableBranches.filter((b) => b.toLowerCase().includes(branchFilter.toLowerCase()))
      : availableBranches
  )

  onMount(() => {
    refreshWorktrees()
  })

  function handleSelect(worktree: WorktreeInfo): void {
    setActiveWorktree(worktree)
  }

  async function startCreate(mode: CreateMode): Promise<void> {
    createMode = mode
    creating = true
    errorMsg = ''
    if (mode === 'checkout') {
      busy = true
      try {
        availableBranches = await window.api.invoke('worktree:branches')
      } catch (err) {
        errorMsg = err instanceof Error ? err.message : 'Failed to load branches'
      } finally {
        busy = false
      }
      branchFilter = ''
      selectedBranch = ''
    } else {
      await tick()
      nameInput?.focus()
    }
  }

  async function handleCreate(): Promise<void> {
    if (createMode === 'new' ? !isValidName : !selectedBranch) return
    busy = true
    errorMsg = ''
    try {
      const created = createMode === 'new'
        ? await window.api.invoke('worktree:create', newName.trim())
        : await window.api.invoke('worktree:checkout', selectedBranch)
      cancelCreate()
      await refreshWorktrees()
      setActiveWorktree(created)
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : 'Operation failed'
    } finally {
      busy = false
    }
  }

  async function handleRemove(worktreePath: string): Promise<void> {
    busy = true
    errorMsg = ''
    try {
      await window.api.invoke('worktree:remove', worktreePath)
      removing = null
      await refreshWorktrees()
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : 'Failed to remove worktree'
      removing = null
    } finally {
      busy = false
    }
  }

  function cancelCreate(): void {
    creating = false
    newName = ''
    selectedBranch = ''
    branchFilter = ''
    errorMsg = ''
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
    <div class="flex gap-1">
      <button
        class="rounded px-1.5 py-0.5 text-xs text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
        onclick={() => startCreate('checkout')}
        title="Check out existing branch"
      >
        Checkout
      </button>
      <button
        class="rounded px-1.5 py-0.5 text-xs text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
        onclick={() => startCreate('new')}
        title="Create new branch"
      >
        + New
      </button>
    </div>
  </div>

  {#if creating && createMode === 'new'}
    <div
      class="flex flex-col gap-1 px-1"
      onfocusout={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          cancelCreate()
        }
      }}
    >
      <div class="flex gap-1">
        <input
          bind:this={nameInput}
          class="flex-1 rounded border border-zinc-600 bg-zinc-800 px-2 py-1 text-xs text-zinc-200 outline-none focus:border-blue-500"
          type="text"
          placeholder="branch-name"
          value={newName}
          oninput={handleNameInput}
          onkeydown={handleKeydown}
        />
        <button
          class="rounded bg-blue-600 px-2 py-1 text-xs text-white hover:bg-blue-500 disabled:opacity-50"
          onclick={handleCreate}
          disabled={!isValidName || busy}
        >
          {busy ? 'Creating…' : 'Create'}
        </button>
      </div>
      {#if errorMsg}
        <p class="text-xs text-red-400">{errorMsg}</p>
      {/if}
    </div>
  {/if}

  {#if creating && createMode === 'checkout'}
    <div
      class="flex flex-col gap-1 px-1"
      onfocusout={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          cancelCreate()
        }
      }}
    >
      <!-- svelte-ignore a11y_autofocus -->
      <input
        class="rounded border border-zinc-600 bg-zinc-800 px-2 py-1 text-xs text-zinc-200 outline-none focus:border-blue-500"
        type="text"
        placeholder="Filter branches…"
        bind:value={branchFilter}
        onkeydown={(e) => {
          if (e.key === 'Escape') cancelCreate()
        }}
        autofocus
      />
      <div class="max-h-40 overflow-y-auto rounded border border-zinc-700 bg-zinc-800">
        {#if busy && availableBranches.length === 0}
          <p class="px-2 py-1 text-xs text-zinc-500">Loading…</p>
        {:else}
          {#each filteredBranches as branch (branch)}
            <button
              class="w-full px-2 py-1 text-left text-xs {selectedBranch === branch
                ? 'bg-blue-600 text-white'
                : 'text-zinc-300 hover:bg-zinc-700'}"
              onclick={() => (selectedBranch = branch)}
              ondblclick={handleCreate}
            >
              {branch}
            </button>
          {:else}
            <p class="px-2 py-1 text-xs text-zinc-500">
              {availableBranches.length === 0 ? 'No branches available' : 'No matches'}
            </p>
          {/each}
        {/if}
      </div>
      {#if errorMsg}
        <p class="text-xs text-red-400">{errorMsg}</p>
      {/if}
      <div class="flex justify-end gap-1">
        <button
          class="rounded px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200"
          onclick={cancelCreate}
        >
          Cancel
        </button>
        <button
          class="rounded bg-blue-600 px-2 py-1 text-xs text-white hover:bg-blue-500 disabled:opacity-50"
          onclick={handleCreate}
          disabled={!selectedBranch || busy}
        >
          {busy ? 'Checking out…' : 'Checkout'}
        </button>
      </div>
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
              class="shrink-0 rounded bg-red-600 px-1.5 py-0.5 text-[10px] text-white hover:bg-red-500 disabled:opacity-50"
              onclick={(e) => {
                e.stopPropagation()
                handleRemove(worktree.path)
              }}
              disabled={busy}
            >
              {busy ? '…' : 'Confirm'}
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
