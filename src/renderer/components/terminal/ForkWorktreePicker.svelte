<script lang="ts">
  import { tick, untrack } from 'svelte'
  import type { WorktreeInfo } from '../../../shared/ipc-types'
  import { worktreeList } from '../../stores/worktrees.svelte'
  import { getClaudeStatus } from '../../stores/claude-status.svelte'
  import { sanitizeBranchName } from '../../lib/branchName'

  /**
   * What the user selected in the picker:
   *  - `existing`: fork into a worktree that already exists at `worktreePath`.
   *  - `create`: create a new worktree/branch named `name`, then fork into it.
   */
  export type ForkTarget =
    | { kind: 'existing'; worktreePath: string }
    | { kind: 'create'; name: string }

  interface Props {
    x: number
    y: number
    /** Worktree the source tab lives in — excluded from the picker. */
    sourceWorktreePath: string
    onpick: (target: ForkTarget) => void
    /** Called when the user wants to back out (Esc, ← button). */
    onback: () => void
    /** Called when the user wants to fully dismiss (Esc twice, click outside). */
    onclose: () => void
  }

  let { x, y, sourceWorktreePath, onpick, onback, onclose }: Props = $props()

  let panelEl: HTMLDivElement | undefined = $state()
  let filterInput: HTMLInputElement | undefined = $state()
  let filter: string = $state('')
  let focusedIndex: number = $state(0)
  let itemEls: (HTMLButtonElement | null)[] = $state([])

  // The filter field does double duty: it narrows the existing-worktree list
  // AND names a new worktree for the "Create new worktree" row. Sanitize on
  // type with the same rules the sidebar's new-worktree form uses, so the
  // create name is always a legal git ref. Existing worktree branches are
  // themselves already sanitized, so filtering still matches them.
  function handleFilterInput(e: Event): void {
    const input = e.target as HTMLInputElement
    const sanitized = sanitizeBranchName(input.value)
    if (sanitized !== input.value) {
      input.value = sanitized
    }
    filter = sanitized
  }

  let posX = $state(untrack(() => x))
  let posY = $state(untrack(() => y))

  // Reposition so the panel stays inside the viewport.
  $effect(() => {
    if (!panelEl) return
    const rect = panelEl.getBoundingClientRect()
    const margin = 4
    if (rect.right > window.innerWidth - margin) {
      posX = Math.max(margin, window.innerWidth - rect.width - margin)
    }
    if (rect.bottom > window.innerHeight - margin) {
      posY = Math.max(margin, window.innerHeight - rect.height - margin)
    }
  })

  // Focus the filter input on mount.
  $effect(() => {
    tick().then(() => filterInput?.focus())
  })

  // Click outside dismisses (full close, not back).
  $effect(() => {
    function onPointerDown(e: PointerEvent): void {
      if (panelEl && !panelEl.contains(e.target as Node)) onclose()
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  })

  type Row =
    | {
        kind: 'existing'
        worktree: WorktreeInfo
        pickable: boolean
        /** Reason this row is not pickable (shown as tooltip / sub-label). */
        blockedReason: string | null
        /** True when another Claude session is running in this worktree. */
        hasActiveAgent: boolean
      }
    | {
        kind: 'create'
        /** The exact (trimmed) name the new worktree/branch will use. */
        name: string
        pickable: boolean
        blockedReason: string | null
      }

  /** Trimmed filter text — the name a "create new worktree" row would use. */
  let trimmedFilter = $derived(filter.trim())

  let existingRows: Row[] = $derived.by(() => {
    const list = worktreeList()
    return list
      .filter((w) =>
        trimmedFilter === ''
          ? true
          : w.branch.toLowerCase().includes(trimmedFilter.toLowerCase()),
      )
      .map((w): Row => {
        const isSource = w.path === sourceWorktreePath
        const status = getClaudeStatus(w.path)
        const hasActiveAgent = status === 'running' || status === 'waiting'
        return {
          kind: 'existing',
          worktree: w,
          pickable: !isSource,
          blockedReason: isSource ? 'cannot fork into the same worktree' : null,
          hasActiveAgent,
        }
      })
  })

  /**
   * When the user has typed a name that doesn't exactly match an existing
   * worktree branch, offer "Create new worktree '<name>'" as the FIRST row.
   * A case-insensitive exact match suppresses it (that worktree is already
   * listed and pickable below).
   */
  let rows: Row[] = $derived.by(() => {
    if (trimmedFilter === '') return existingRows
    const exactMatch = existingRows.some(
      (r) => r.kind === 'existing' && r.worktree.branch.toLowerCase() === trimmedFilter.toLowerCase(),
    )
    if (exactMatch) return existingRows
    const createRow: Row = {
      kind: 'create',
      name: trimmedFilter,
      pickable: true,
      blockedReason: null,
    }
    return [createRow, ...existingRows]
  })

  function firstPickableIndex(): number {
    return rows.findIndex((r) => r.pickable)
  }

  // Keep focusedIndex pointing at a pickable row as the filter narrows.
  $effect(() => {
    void rows
    if (rows.length === 0) {
      focusedIndex = -1
      return
    }
    if (focusedIndex < 0 || focusedIndex >= rows.length || !rows[focusedIndex]?.pickable) {
      focusedIndex = firstPickableIndex()
    }
  })

  function nextPickable(from: number, dir: 1 | -1): number {
    const n = rows.length
    if (n === 0) return -1
    let i = from
    for (let step = 0; step < n; step++) {
      i = (i + dir + n) % n
      if (rows[i].pickable) return i
    }
    return from
  }

  function pickRow(r: Row): void {
    if (!r.pickable) return
    if (r.kind === 'create') {
      onpick({ kind: 'create', name: r.name })
    } else {
      onpick({ kind: 'existing', worktreePath: r.worktree.path })
    }
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      onback()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      focusedIndex = nextPickable(focusedIndex, 1)
      itemEls[focusedIndex]?.focus()
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      focusedIndex = nextPickable(focusedIndex, -1)
      itemEls[focusedIndex]?.focus()
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const r = rows[focusedIndex]
      if (r) pickRow(r)
    }
  }
</script>

<div
  bind:this={panelEl}
  role="dialog"
  aria-label="Fork into worktree"
  class="fixed z-50 flex w-[280px] flex-col rounded border border-zinc-700 bg-zinc-900 text-sm text-zinc-200 shadow-xl outline-none"
  style:left="{posX}px"
  style:top="{posY}px"
  onkeydown={handleKeydown}
  tabindex="-1"
>
  <div class="flex items-center gap-1 border-b border-zinc-800 px-2 py-1.5">
    <button
      type="button"
      class="flex h-5 w-5 items-center justify-center rounded text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
      aria-label="Back to tab menu"
      onclick={onback}
    >
      ←
    </button>
    <span class="text-xs text-zinc-400">Fork into worktree…</span>
  </div>

  <input
    bind:this={filterInput}
    value={filter}
    oninput={handleFilterInput}
    type="text"
    placeholder="filter worktrees…"
    class="border-b border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-200 outline-none placeholder:text-zinc-600"
  />

  <div class="max-h-[280px] overflow-y-auto py-1">
    {#if rows.length === 0}
      <div class="px-3 py-2 text-xs text-zinc-500">No matching worktrees</div>
    {/if}
    {#each rows as r, i (r.kind === 'create' ? '__create__' : r.worktree.path)}
      <button
        bind:this={itemEls[i]}
        type="button"
        class="flex w-full items-center justify-between px-3 py-1.5 text-left outline-none {r.pickable
          ? 'hover:bg-zinc-800 focus:bg-zinc-800'
          : 'cursor-not-allowed text-zinc-500'}"
        disabled={!r.pickable}
        aria-disabled={!r.pickable ? 'true' : undefined}
        title={r.blockedReason ?? ''}
        onclick={() => pickRow(r)}
        onmouseenter={() => {
          if (r.pickable) focusedIndex = i
        }}
      >
        {#if r.kind === 'create'}
          <span class="truncate text-zinc-200">
            Create new worktree <span class="font-medium text-orange-300">{r.name}</span>
          </span>
          <span
            class="ml-2 shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400"
          >
            new
          </span>
        {:else}
          <span class="truncate">{r.worktree.branch}</span>
          {#if r.hasActiveAgent}
            <span
              class="ml-2 shrink-0 rounded bg-yellow-900/40 px-1.5 py-0.5 text-[10px] text-yellow-300"
              title="A Claude session is currently running here"
            >
              agent
            </span>
          {/if}
        {/if}
      </button>
    {/each}
  </div>
</div>
