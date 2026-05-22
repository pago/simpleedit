<script lang="ts">
  import { tick, untrack } from 'svelte'
  import type { WorktreeInfo } from '../../../shared/ipc-types'
  import { worktreeList } from '../../stores/worktrees.svelte'
  import { getClaudeStatus } from '../../stores/claude-status.svelte'

  interface Props {
    x: number
    y: number
    /** Worktree the source tab lives in — excluded from the picker. */
    sourceWorktreePath: string
    onpick: (targetWorktreePath: string) => void
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

  interface Row {
    worktree: WorktreeInfo
    pickable: boolean
    /** Reason this row is not pickable (shown as tooltip / sub-label). */
    blockedReason: string | null
    /** True when another Claude session is running in this worktree. */
    hasActiveAgent: boolean
  }

  let rows: Row[] = $derived.by(() => {
    const list = worktreeList()
    return list
      .filter((w) =>
        filter === '' ? true : w.branch.toLowerCase().includes(filter.toLowerCase()),
      )
      .map((w): Row => {
        const isSource = w.path === sourceWorktreePath
        const status = getClaudeStatus(w.path)
        const hasActiveAgent = status === 'running' || status === 'waiting'
        return {
          worktree: w,
          pickable: !isSource,
          blockedReason: isSource ? 'cannot fork into the same worktree' : null,
          hasActiveAgent,
        }
      })
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
    onpick(r.worktree.path)
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
    bind:value={filter}
    type="text"
    placeholder="filter worktrees…"
    class="border-b border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-200 outline-none placeholder:text-zinc-600"
  />

  <div class="max-h-[280px] overflow-y-auto py-1">
    {#if rows.length === 0}
      <div class="px-3 py-2 text-xs text-zinc-500">No matching worktrees</div>
    {/if}
    {#each rows as r, i (r.worktree.path)}
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
        <span class="truncate">{r.worktree.branch}</span>
        {#if r.hasActiveAgent}
          <span
            class="ml-2 shrink-0 rounded bg-yellow-900/40 px-1.5 py-0.5 text-[10px] text-yellow-300"
            title="A Claude session is currently running here"
          >
            agent
          </span>
        {/if}
      </button>
    {/each}
  </div>
</div>
