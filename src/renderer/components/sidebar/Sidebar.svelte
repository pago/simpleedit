<script lang="ts">
  import SessionList from './SessionList.svelte'
  import WorktreeList from './WorktreeList.svelte'
</script>

<div class="flex h-full flex-col">
  <!-- Sessions are the primary navigation entity; worktrees are demoted to a
       management section (create/checkout/delete + repoint active session). -->
  <section class="flex-1 overflow-y-auto px-3 pb-2">
    <SessionList />
  </section>

  <section class="max-h-[40%] flex-none overflow-y-auto border-t border-zinc-700 px-3 pb-2">
    <WorktreeList />
  </section>
</div>
