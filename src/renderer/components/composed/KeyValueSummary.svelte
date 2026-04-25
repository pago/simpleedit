<script lang="ts">
  import type { BaseComponentProps } from '@json-render/svelte'
  import type { z } from 'zod'
  import type { KeyValueSummaryProps as KeyValueSummaryPropsSchema } from '../../../shared/gen-ui-catalog'

  type KeyValueSummaryProps = z.infer<typeof KeyValueSummaryPropsSchema>

  let { props }: BaseComponentProps<KeyValueSummaryProps> = $props()

  const VALUE_STYLES: Record<NonNullable<KeyValueSummaryProps['items'][number]['status']>, string> = {
    ok: 'text-green-300',
    warn: 'text-amber-300',
    error: 'text-red-300',
  }
</script>

<dl class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
  {#each props.items as item, i (i)}
    <dt class="text-zinc-400">{item.label}</dt>
    <dd class={item.status ? VALUE_STYLES[item.status] : 'text-zinc-200'}>
      {item.value}
    </dd>
  {/each}
</dl>
