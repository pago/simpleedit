<script lang="ts">
  import WorktreeList from './WorktreeList.svelte'
  import GitLog from './GitLog.svelte'
  import { getActiveWorktree } from '../../stores/worktrees.svelte'

  let activeWorktreePath = $derived(getActiveWorktree()?.path ?? null)
</script>

<div class="flex h-full flex-col">
  <header class="border-b border-zinc-700 px-3 py-2">
    <h1 class="text-sm font-semibold tracking-wide text-zinc-300">SimpleEdit</h1>
  </header>

  <section class="flex-1 overflow-y-auto px-3 py-2">
    <WorktreeList />
  </section>

  <section class="flex-1 overflow-y-auto border-t border-zinc-700 px-3 py-2">
    <GitLog worktreePath={activeWorktreePath} />
  </section>
</div>
