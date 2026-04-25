<script lang="ts">
  import type { BaseComponentProps } from '@json-render/svelte'
  import type { z } from 'zod'
  import type { StatusIndicatorProps as StatusIndicatorPropsSchema } from '../../../shared/gen-ui-catalog'

  type StatusIndicatorProps = z.infer<typeof StatusIndicatorPropsSchema>

  let { props }: BaseComponentProps<StatusIndicatorProps> = $props()

  const DOT_STYLES: Record<StatusIndicatorProps['kind'], string> = {
    running: 'bg-blue-400 animate-pulse',
    ok: 'bg-green-400',
    warn: 'bg-amber-400',
    error: 'bg-red-400',
    pending: 'bg-zinc-500',
  }
</script>

<div class="inline-flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-900/60 px-2.5 py-1 text-xs">
  <span class="inline-block h-2 w-2 rounded-full {DOT_STYLES[props.kind]}"></span>
  <span class="text-zinc-200">{props.label}</span>
  {#if props.detail}
    <span class="text-zinc-500">{props.detail}</span>
  {/if}
</div>
