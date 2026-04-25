<script lang="ts">
  import type { BaseComponentProps } from '@json-render/svelte'
  import { getActionContext } from '@json-render/svelte'
  import type { z } from 'zod'
  import type { DecisionCardProps as DecisionCardPropsSchema, ActionRef } from '../../../shared/gen-ui-catalog'
  import { actionRefToBinding } from './action-ref'

  type DecisionCardProps = z.infer<typeof DecisionCardPropsSchema>

  let { props }: BaseComponentProps<DecisionCardProps> = $props()

  const actions = getActionContext()

  const VARIANT_STYLES: Record<NonNullable<DecisionCardProps['options'][number]['variant']>, string> = {
    primary: 'bg-blue-700/80 text-blue-100 hover:bg-blue-600 border-blue-600/60',
    danger: 'bg-red-700/80 text-red-100 hover:bg-red-600 border-red-600/60',
    default: 'bg-zinc-800 text-zinc-200 hover:bg-zinc-700 border-zinc-700',
  }

  function dispatch(action: ActionRef): void {
    void actions.execute(actionRefToBinding(action))
  }
</script>

<div class="flex flex-col gap-3 rounded border border-zinc-800 bg-zinc-900/60 p-3">
  <div class="text-sm font-medium text-zinc-100">{props.question}</div>
  {#if props.context}
    <p class="text-xs text-zinc-400">{props.context}</p>
  {/if}
  <div class="flex flex-wrap gap-2">
    {#each props.options as option, i (i)}
      <button
        type="button"
        class="rounded border px-3 py-1.5 text-xs font-medium {VARIANT_STYLES[option.variant ?? 'default']}"
        onclick={() => dispatch(option.action)}
      >
        {option.label}
      </button>
    {/each}
  </div>
</div>
