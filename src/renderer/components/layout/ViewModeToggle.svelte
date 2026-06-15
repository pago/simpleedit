<script lang="ts">
  import type { MarkdownViewMode } from '../../stores/markdownView.svelte'

  interface Props {
    current: MarkdownViewMode
    onsetmode: (mode: MarkdownViewMode) => void
  }

  let { current, onsetmode }: Props = $props()

  const modes: { mode: MarkdownViewMode; title: string }[] = [
    { mode: 'raw', title: 'Editor only' },
    { mode: 'hybrid', title: 'Editor and preview' },
    { mode: 'rendered', title: 'Preview only' },
  ]
</script>

<div
  role="group"
  aria-label="Markdown view mode"
  data-testid="md-view-toggle"
  class="flex items-center gap-0.5 rounded border border-zinc-800 bg-zinc-900 p-0.5"
>
  {#each modes as { mode, title } (mode)}
    {@const active = current === mode}
    <button
      type="button"
      data-testid="md-view-toggle-button"
      data-mode={mode}
      aria-pressed={active}
      {title}
      class="flex h-6 w-6 items-center justify-center rounded transition-colors
        {active ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300'}"
      onclick={() => onsetmode(mode)}
    >
      {#if mode === 'raw'}
        <!-- Editor / source lines -->
        <svg class="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M3 4h10M3 8h10M3 12h6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
        </svg>
      {:else if mode === 'hybrid'}
        <!-- Split: editor + preview -->
        <svg class="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect x="2.5" y="3" width="11" height="10" rx="1.5" stroke="currentColor" stroke-width="1.2" />
          <path d="M8 3v10" stroke="currentColor" stroke-width="1.2" />
        </svg>
      {:else}
        <!-- Preview / eye -->
        <svg class="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M1.5 8S3.8 4 8 4s6.5 4 6.5 4-2.3 4-6.5 4S1.5 8 1.5 8Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
          <circle cx="8" cy="8" r="1.6" stroke="currentColor" stroke-width="1.2" />
        </svg>
      {/if}
    </button>
  {/each}
</div>
