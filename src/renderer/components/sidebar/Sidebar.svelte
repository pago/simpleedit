<script lang="ts">
  import WorktreeList from './WorktreeList.svelte'
  import GitLog from './GitLog.svelte'
  import { activeWorktree } from '../../stores/worktrees.svelte'
</script>

<div class="flex h-full flex-col">
  <section class="flex-1 overflow-y-auto px-3 py-2">
    <WorktreeList />
  </section>

  <section class="flex-1 overflow-y-auto border-t border-zinc-700 px-3 py-2">
    <GitLog worktreePath={activeWorktree()?.path ?? null} />
  </section>
</div>
