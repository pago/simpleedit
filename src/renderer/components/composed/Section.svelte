<script lang="ts">
  import type { BaseComponentProps } from '@json-render/svelte'
  import type { z } from 'zod'
  import type { SectionProps as SectionPropsSchema } from '../../../shared/gen-ui-catalog'

  type SectionProps = z.infer<typeof SectionPropsSchema>

  let { props, children }: BaseComponentProps<SectionProps> = $props()

  let open = $state(props.defaultOpen ?? true)
</script>

<section class="flex flex-col rounded border border-zinc-800 bg-zinc-900/40">
  <!-- `data-section-toggle` is how `focus_block` expands a collapsed section on
       its way to a block inside it — see focus-block.ts. -->
  <button
    type="button"
    data-section-toggle
    class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-zinc-300 hover:bg-zinc-800/40"
    aria-expanded={open}
    onclick={() => (open = !open)}
  >
    <span class="inline-block w-3 text-zinc-500 transition-transform" class:rotate-90={open}>
      &#9656;
    </span>
    <span class="flex-1">{props.title}</span>
  </button>
  {#if open}
    <div class="flex flex-col gap-2 border-t border-zinc-800/60 px-3 py-2">
      {@render children?.()}
    </div>
  {/if}
</section>
