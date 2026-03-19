<script lang="ts">
  import WorktreeList from './WorktreeList.svelte'
</script>

<div class="flex h-full flex-col">
  <header class="border-b border-zinc-700 px-3 py-2">
    <h1 class="text-sm font-semibold tracking-wide text-zinc-300">SimpleEdit</h1>
  </header>

  <section class="flex-1 overflow-y-auto px-3 py-2">
    <WorktreeList />
  </section>

  <section class="border-t border-zinc-700 px-3 py-2">
    <p class="text-xs text-zinc-500">Git log will appear here</p>
  </section>
</div>
