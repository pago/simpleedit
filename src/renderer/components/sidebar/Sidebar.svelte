<script lang="ts">
  import WorktreeList from './WorktreeList.svelte'
  import GitLog from './GitLog.svelte'
  import { activeWorktree } from '../../stores/worktrees.svelte'
</script>

<div class="flex h-full flex-col">
  <!-- Top padding lives on the sticky section headers (WorktreeList, GitLog)
       so they sit flush with the scroll viewport when pinned. -->
  <section class="flex-1 overflow-y-auto px-3 pb-2">
    <WorktreeList />
  </section>

  <section class="flex-1 overflow-y-auto border-t border-zinc-700 px-3 pb-2">
    <GitLog worktreePath={activeWorktree()?.path ?? null} />
  </section>
</div>
