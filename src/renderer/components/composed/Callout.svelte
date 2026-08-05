<script lang="ts">
  import type { BaseComponentProps } from '@json-render/svelte'
  import type { z } from 'zod'
  import type { CalloutProps as CalloutPropsSchema } from '../../../shared/gen-ui-catalog'
  import { renderMarkdown } from '../../lib/markdown'

  type CalloutProps = z.infer<typeof CalloutPropsSchema>

  let { props }: BaseComponentProps<CalloutProps> = $props()

  const bodyHtml = $derived(renderMarkdown(props.body))

  const VARIANT_STYLES: Record<CalloutProps['variant'], string> = {
    info: 'border-blue-800/60 bg-blue-950/40 text-blue-200',
    warn: 'border-amber-800/60 bg-amber-950/40 text-amber-200',
    error: 'border-red-800/60 bg-red-950/40 text-red-200',
    success: 'border-green-800/60 bg-green-950/40 text-green-200',
  }
</script>

<div class="flex flex-col gap-1 rounded border px-3 py-2 text-xs {VARIANT_STYLES[props.variant]}">
  {#if props.title}
    <div class="font-semibold">{props.title}</div>
  {/if}
  <!-- Same markdown path as ProseBlock; `callout-prose` hands the variant's own
       colour and size back to the typography plugin's output. -->
  <div class="prose prose-invert prose-sm callout-prose max-w-none">
    {@html bodyHtml}
  </div>
</div>
