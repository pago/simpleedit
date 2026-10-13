<script lang="ts">
  import type { Snippet } from 'svelte'

  interface Props {
    label: string
    expanded: boolean
    onexpand: () => void
    icon: Snippet
    /** Dot or badge after the label, inside the header button. */
    indicator?: Snippet
    /** Buttons beside the header button: they work while the section is collapsed. */
    actions?: Snippet
    children: Snippet
  }

  let { label, expanded, onexpand, icon, indicator, actions, children }: Props = $props()
</script>

<section class="flex flex-col {expanded ? 'min-h-0 flex-1' : 'flex-none'}" aria-label={label}>
  <div class="flex-none border-b border-zinc-800 px-2 py-1">
    <div
      class="flex items-center gap-1 rounded-md pr-1 transition-colors
        {expanded ? 'bg-zinc-800 text-zinc-100 shadow-[inset_2px_0_0_theme(colors.blue.500)]' : 'text-zinc-300 hover:bg-zinc-800'}"
    >
      <!-- The open section stays open: exactly one is always expanded. -->
      <button
        class="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left"
        aria-expanded={expanded}
        onclick={() => {
          if (!expanded) onexpand()
        }}
      >
        {@render icon()}
        <span class="min-w-0 flex-1 truncate text-xs font-medium">{label}</span>
        {@render indicator?.()}
      </button>
      {@render actions?.()}
    </div>
  </div>
  {#if expanded}
    <div class="@container min-h-0 flex-1 overflow-y-auto">
      {@render children()}
    </div>
  {/if}
</section>
