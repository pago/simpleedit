<script lang="ts">
  import SessionList from './SessionList.svelte'
  import MagnifierIcon from '../screenprs/MagnifierIcon.svelte'
  import { uiView } from '../../stores/uiView.svelte'
  import { screenPrsStore } from '../../stores/screenprs.svelte'

  let active = $derived(uiView.current() === 'screenprs')
  let attention = $derived(screenPrsStore.attentionCount())
</script>

<!-- Sessions are the primary sidebar entity; Screen PRs (an org-wide view, not a
     session) is pinned below the list. Worktree management lives in each
     workspace's worktree popover (SessionWorkspace header). -->
<div class="flex h-full flex-col">
  <div class="min-h-0 flex-1 overflow-y-auto px-3 pb-2">
    <SessionList />
  </div>

  <div class="flex-none border-t border-zinc-800 p-2">
    <button
      class="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left transition-colors
        {active ? 'bg-zinc-800 text-zinc-100 shadow-[inset_2px_0_0_theme(colors.blue.500)]' : 'text-zinc-300 hover:bg-zinc-800'}"
      onclick={() => uiView.show('screenprs')}
    >
      <MagnifierIcon class="h-4 w-4 flex-none text-zinc-400" />
      <span class="flex-1 text-xs font-medium">Screen PRs</span>
      {#if attention > 0}
        <span class="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-red-500 px-1.5 text-[10px] font-bold tabular-nums text-white">{attention}</span>
      {/if}
    </button>
  </div>
</div>
