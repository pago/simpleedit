<script lang="ts">
  import { backlogStore } from '../../stores/backlog.svelte'
  import { uiView } from '../../stores/uiView.svelte'
  import { labelFromBrief } from '../../../shared/brief'

  /** How long a notice stays before it dismisses itself. */
  const NOTICE_MS = 12_000

  const latest = $derived(backlogStore.arrivals.at(-1))

  $effect(() => {
    const item = latest
    if (!item) return
    const timer = setTimeout(() => backlogStore.dismissArrival(item.id), NOTICE_MS)
    return () => clearTimeout(timer)
  })

  async function edit(id: string): Promise<void> {
    backlogStore.dismissArrival(id)
    // Held when the open item can't be saved: the backlog then shows why.
    await backlogStore.requestSelect(id)
    uiView.show('backlog')
  }
</script>

<!-- An agent added work you haven't read: say so wherever you are, so its
     prompt gets a look before anyone starts it. -->
{#if latest}
  <div
    class="fixed right-4 bottom-4 z-40 flex max-w-sm items-start gap-3 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 shadow-xl"
    role="status"
  >
    <div class="min-w-0 flex-1 text-xs">
      <div class="text-zinc-400">Added to backlog{latest.createdBySession ? ` by “${latest.createdBySession}”` : ''}</div>
      <div class="truncate text-sm text-zinc-100">{latest.label || labelFromBrief(latest.prompt) || latest.prompt.split('\n')[0]}</div>
    </div>
    <button class="rounded bg-blue-600 px-2 py-0.5 text-xs text-white hover:bg-blue-500" onclick={() => void edit(latest.id)}>Edit</button>
    <button class="text-xs text-zinc-500 hover:text-zinc-300" onclick={() => backlogStore.dismissArrival(latest.id)} aria-label="Dismiss">✕</button>
  </div>
{/if}
