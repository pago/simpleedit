<script lang="ts">
  import MagnifierIcon from '../screenprs/MagnifierIcon.svelte'
  import type { UiView } from '../../stores/uiView.svelte'

  let { view, class: cls = 'h-4 w-4 flex-none text-zinc-400' }: { view: UiView; class?: string } = $props()
</script>

{#if view === 'workspace'}
  <svg class={cls} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
    <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
    <path d="M5 6.5l2 1.5-2 1.5M8.5 10H11" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
{:else if view === 'backlog'}
  <svg class={cls} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
    <path d="M3 4h10M3 8h10M3 12h6" stroke-linecap="round" />
  </svg>
{:else}
  <MagnifierIcon class={cls} />
{/if}
