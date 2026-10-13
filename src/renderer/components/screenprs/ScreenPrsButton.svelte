<script lang="ts">
  import { screenPrsStore } from '../../stores/screenprs.svelte'
  import { triageModel } from '../../stores/triageModel.svelte'
  import { uiView } from '../../stores/uiView.svelte'
  import { sidebarRail } from '../../stores/sidebarRail.svelte'

  let status = $derived(screenPrsStore.status())
  let total = $derived(screenPrsStore.total())
  let done = $derived([...Object.values(screenPrsStore.byBucket())].reduce((n, arr) => n + arr.length, 0))

  function screen(force: boolean): void {
    uiView.show('screenprs')
    sidebarRail.chose('screenprs')
    void triageModel.refresh()
    void screenPrsStore.start({ force })
  }
</script>

{#if status === 'running'}
  <span
    class="flex-none text-[11px] tabular-nums text-zinc-500"
    title={total === undefined ? 'Finding PRs…' : `Screened ${done} of ${total} PRs`}
    data-testid="screening-progress">{total === undefined ? '…' : `${done}/${total}`}</span
  >
  <button
    class="flex h-5 flex-none items-center rounded px-1.5 text-[11px] text-zinc-500 hover:bg-zinc-700 hover:text-zinc-300"
    title="Stop screening"
    onclick={() => void screenPrsStore.cancel()}
  >
    Stop
  </button>
{:else}
  <button
    class="flex h-5 flex-none items-center rounded px-1.5 text-[11px] text-zinc-500 hover:bg-zinc-700 hover:text-zinc-300"
    title={done > 0 ? 'Re-screen (⌥-click to ignore cache and re-run all)' : 'Screen your review queue'}
    onclick={(e) => screen(e.altKey)}
  >
    {done > 0 ? 'Re-screen' : 'Screen'}
  </button>
{/if}
