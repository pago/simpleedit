<script lang="ts">
  import WorktreePane from './WorktreePane.svelte'
  import { worktreeStore } from '../../stores/worktrees.svelte'
  import type { WorktreeInfo } from '../../../shared/ipc-types'

  let splitRatio = $state(50)
  let isResizing = $state(false)
  let secondPaneWorktree = $state<WorktreeInfo | null>(null)

  let primaryPath = $derived(worktreeStore.active?.path ?? null)
  let secondaryPath = $derived(secondPaneWorktree?.path ?? null)
  let hasTwoPanes = $derived(secondaryPath !== null)

  // Available worktrees for the second pane (exclude the active one)
  let availableForSecondPane = $derived(
    worktreeStore.list.filter((w) => w.path !== primaryPath)
  )

  function openSecondPane(): void {
    if (availableForSecondPane.length > 0) {
      secondPaneWorktree = availableForSecondPane[0]
    }
  }

  function closeSecondPane(): void {
    secondPaneWorktree = null
  }

  function onSplitResizeStart(e: MouseEvent): void {
    isResizing = true
    const container = document.getElementById('pane-manager')!

    function onMouseMove(ev: MouseEvent) {
      const rect = container.getBoundingClientRect()
      const pct = ((ev.clientX - rect.left) / rect.width) * 100
      splitRatio = Math.max(25, Math.min(75, pct))
    }

    function onMouseUp() {
      isResizing = false
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }
</script>

<div
  id="pane-manager"
  class="flex h-full"
  class:select-none={isResizing}
>
  {#if primaryPath}
    <!-- Primary pane -->
    <div
      class="min-w-0 overflow-hidden"
      style:width={hasTwoPanes ? `${splitRatio}%` : '100%'}
    >
      <div class="flex h-full flex-col">
        <!-- Pane header -->
        <div class="flex h-7 flex-none items-center justify-between border-b border-zinc-800 bg-zinc-900 px-2">
          <span class="truncate text-[11px] font-medium text-zinc-400">
            {worktreeStore.active?.branch ?? 'primary'}
          </span>
          <div class="flex items-center gap-1">
            {#if !hasTwoPanes && availableForSecondPane.length > 0}
              <button
                class="rounded px-1.5 py-0.5 text-[10px] text-zinc-500 hover:bg-zinc-700 hover:text-zinc-300"
                onclick={openSecondPane}
                title="Split view"
              >
                Split
              </button>
            {/if}
          </div>
        </div>
        <div class="min-h-0 flex-1">
          {#key primaryPath}
            <WorktreePane worktreePath={primaryPath} paneId="primary" />
          {/key}
        </div>
      </div>
    </div>

    {#if hasTwoPanes && secondaryPath}
      <!-- Resize handle between panes -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
      <div
        class="w-1 flex-none cursor-col-resize bg-zinc-800 hover:bg-blue-500 transition-colors"
        role="separator"
        aria-orientation="vertical"
        tabindex="0"
        onmousedown={onSplitResizeStart}
      ></div>

      <!-- Secondary pane -->
      <div class="min-w-0 flex-1 overflow-hidden">
        <div class="flex h-full flex-col">
          <!-- Pane header with worktree selector -->
          <div class="flex h-7 flex-none items-center justify-between border-b border-zinc-800 bg-zinc-900 px-2">
            <select
              class="max-w-[140px] truncate rounded border-none bg-transparent text-[11px] font-medium text-zinc-400 outline-none hover:text-zinc-200"
              value={secondaryPath}
              onchange={(e) => {
                const path = (e.target as HTMLSelectElement).value
                const wt = worktreeStore.list.find((w) => w.path === path)
                if (wt) secondPaneWorktree = wt
              }}
            >
              {#each availableForSecondPane as wt (wt.path)}
                <option value={wt.path} class="bg-zinc-800">{wt.branch}</option>
              {/each}
            </select>
            <button
              class="rounded px-1.5 py-0.5 text-[10px] text-zinc-500 hover:bg-zinc-700 hover:text-zinc-300"
              onclick={closeSecondPane}
              title="Close split"
            >
              Close
            </button>
          </div>
          <div class="min-h-0 flex-1">
            {#key secondaryPath}
              <WorktreePane worktreePath={secondaryPath} paneId="secondary" />
            {/key}
          </div>
        </div>
      </div>
    {/if}
  {:else}
    <div class="flex h-full w-full items-center justify-center">
      <p class="text-sm text-zinc-600">Select a worktree from the sidebar to get started</p>
    </div>
  {/if}
</div>
