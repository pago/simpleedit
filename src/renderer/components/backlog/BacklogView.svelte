<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import BacklogItemDetail from './BacklogItemDetail.svelte'
  import BacklogNewButton from './BacklogNewButton.svelte'
  import { sidebarRail } from '../../stores/sidebarRail.svelte'
  import { backlogStore } from '../../stores/backlog.svelte'
  import { backlogView } from '../../stores/backlogViewState.svelte'

  const selectedId = $derived(backlogStore.selectedId)
  const projectName = $derived(backlogStore.project?.replace(/\/+$/, '').split('/').pop()?.replace(/\.git$/, '') ?? '')

  onMount(() => backlogView.watchModels())
  onDestroy(() => backlogView.close())
</script>

<div class="flex h-full flex-col bg-zinc-950">
  <header class="flex flex-none items-center gap-3 border-b border-zinc-800 px-5 py-3">
    <div class="min-w-0 flex-1">
      <h1 class="text-[15px] font-semibold text-zinc-100">Backlog</h1>
      <p class="truncate text-xs text-zinc-500">
        Prepared sessions for {projectName || 'this project'}. Agents add here when you say “add this to our backlog”.
      </p>
    </div>
    {#if sidebarRail.collapsed()}
      <BacklogNewButton />
    {/if}
  </header>

  <div class="min-h-0 flex-1">
    {#if selectedId}
      <!-- Keyed: the detail takes a copy of its item when it opens. -->
      {#key selectedId}
        <BacklogItemDetail
          bind:unsaved={backlogView.unsaved}
          id={selectedId}
          item={backlogStore.get(selectedId)}
          models={backlogView.models}
          noModels={backlogView.noModels}
          focus={selectedId === backlogView.newId}
          onmodelsfocus={() => backlogView.refreshModels()}
          oncreated={() => (backlogView.newId = null)}
          onreplaced={(id) => {
            backlogView.newId = null
            // The detail has just discarded its text, so nothing is held.
            backlogStore.select(id)
          }}
        />
      {/key}
    {:else}
      <div class="flex h-full items-center justify-center text-xs text-zinc-600">Pick an item, or add one with + New.</div>
    {/if}
  </div>
</div>
