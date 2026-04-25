<script lang="ts">
  import type { BaseComponentProps } from '@json-render/svelte'
  import type { z } from 'zod'
  import type { CalloutProps as CalloutPropsSchema } from '../../../shared/gen-ui-catalog'

  type CalloutProps = z.infer<typeof CalloutPropsSchema>

  let { props }: BaseComponentProps<CalloutProps> = $props()

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
  <div class="text-current/90">{props.body}</div>
</div>
