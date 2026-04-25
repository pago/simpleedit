<script lang="ts">
  import type { BaseComponentProps } from '@json-render/svelte'
  import { getActionContext, getStateContext } from '@json-render/svelte'
  import type { z } from 'zod'
  import type { TextInputProps as TextInputPropsSchema } from '../../../shared/gen-ui-catalog'
  import { actionRefToBinding } from './action-ref'

  type TextInputProps = z.infer<typeof TextInputPropsSchema>

  let { props }: BaseComponentProps<TextInputProps> = $props()

  const state = getStateContext()
  const actions = getActionContext()

  const value = $derived(((state.get(props.bind) as string | undefined) ?? '') as string)

  function onInput(e: Event): void {
    const target = e.currentTarget as HTMLInputElement
    state.set(props.bind, target.value)
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key !== 'Enter' || !props.submitAction) return
    e.preventDefault()
    void actions.execute(actionRefToBinding(props.submitAction))
  }
</script>

<input
  type="text"
  class="w-full rounded border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-blue-500"
  placeholder={props.placeholder ?? ''}
  {value}
  oninput={onInput}
  onkeydown={onKeydown}
/>
