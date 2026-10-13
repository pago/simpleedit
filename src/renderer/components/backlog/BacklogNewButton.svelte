<script lang="ts">
  import { backlogView } from '../../stores/backlogViewState.svelte'
  import { uiView } from '../../stores/uiView.svelte'
  import { sidebarRail } from '../../stores/sidebarRail.svelte'

  function addItem(): void {
    uiView.show('backlog')
    sidebarRail.chose('backlog')
    void backlogView.choose('new')
  }
</script>

<button
  class="flex h-5 flex-none items-center rounded px-1.5 text-[11px] text-zinc-500 hover:bg-zinc-700 hover:text-zinc-300"
  title="New backlog item"
  onclick={addItem}
>
  + New
</button>
