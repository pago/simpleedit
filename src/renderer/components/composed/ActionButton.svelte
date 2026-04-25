<script lang="ts">
  import type { BaseComponentProps } from '@json-render/svelte'
  import { getActionContext } from '@json-render/svelte'
  import type { z } from 'zod'
  import type { ActionButtonProps as ActionButtonPropsSchema } from '../../../shared/gen-ui-catalog'
  import { actionRefToBinding } from './action-ref'

  type ActionButtonProps = z.infer<typeof ActionButtonPropsSchema>

  let { props }: BaseComponentProps<ActionButtonProps> = $props()

  const actions = getActionContext()

  const VARIANT_STYLES: Record<NonNullable<ActionButtonProps['variant']>, string> = {
    primary: 'bg-blue-700/80 text-blue-100 hover:bg-blue-600 border-blue-600/60',
    secondary: 'bg-zinc-800 text-zinc-200 hover:bg-zinc-700 border-zinc-700',
    danger: 'bg-red-700/80 text-red-100 hover:bg-red-600 border-red-600/60',
    ghost: 'bg-transparent text-zinc-300 hover:bg-zinc-800/60 border-transparent',
  }

  function dispatch(): void {
    void actions.execute(actionRefToBinding(props.action))
  }
</script>

<button
  type="button"
  class="rounded border px-3 py-1.5 text-xs font-medium {VARIANT_STYLES[props.variant ?? 'secondary']}"
  onclick={dispatch}
>
  {props.label}
</button>
