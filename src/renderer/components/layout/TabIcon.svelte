<script lang="ts">
  import type { TabKind } from '../../stores/tabsStore.svelte'

  interface Props {
    kind: TabKind
    class?: string
  }

  let { kind, class: className = '' }: Props = $props()
</script>

{#if kind === 'file'}
  <!-- Document glyph -->
  <svg data-testid="tab-kind-icon" data-kind="file" class={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path
      d="M3 2.5A1.5 1.5 0 0 1 4.5 1h5L13 4.5V13.5A1.5 1.5 0 0 1 11.5 15h-7A1.5 1.5 0 0 1 3 13.5v-11Z"
      stroke="currentColor"
      stroke-width="1.2"
      stroke-linejoin="round"
    />
    <path d="M9 1v3.5a.5.5 0 0 0 .5.5H13" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
  </svg>
{:else if kind === 'diff'}
  <!-- Git-commit glyph: horizontal line through a circle -->
  <svg data-testid="tab-kind-icon" data-kind="diff" class={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <circle cx="8" cy="8" r="3" stroke="currentColor" stroke-width="1.4" />
    <path d="M1.5 8h3.3M11.2 8h3.3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
  </svg>
{:else if kind === 'tour'}
  <!-- Compass glyph -->
  <svg data-testid="tab-kind-icon" data-kind="tour" class={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.2" />
    <path d="m10.5 5.5-4 1.2-1.2 4 4-1.2 1.2-4Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
  </svg>
{:else if kind === 'composed'}
  <!-- Reserved: Claude sparkle glyph matching the ✦ terminal tab button -->
  <span data-testid="tab-kind-icon" data-kind="composed" class="{className} inline-flex items-center justify-center font-semibold leading-none" aria-hidden="true">✦</span>
{/if}
