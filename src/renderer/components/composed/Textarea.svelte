<script lang="ts">
  import type { BaseComponentProps } from '@json-render/svelte'
  import { getActionContext, getStateContext } from '@json-render/svelte'
  import type { z } from 'zod'
  import type { TextareaProps as TextareaPropsSchema } from '../../../shared/gen-ui-catalog'
  import { actionRefToBinding } from './action-ref'

  type TextareaProps = z.infer<typeof TextareaPropsSchema>

  let { props }: BaseComponentProps<TextareaProps> = $props()

  const state = getStateContext()
  const actions = getActionContext()

  const value = $derived(((state.get(props.bind) as string | undefined) ?? '') as string)

  function onInput(e: Event): void {
    const target = e.currentTarget as HTMLTextAreaElement
    state.set(props.bind, target.value)
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey) || !props.submitAction) return
    e.preventDefault()
    void actions.execute(actionRefToBinding(props.submitAction))
  }
</script>

<textarea
  class="w-full resize-y rounded border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-blue-500"
  rows="3"
  placeholder={props.placeholder ?? ''}
  {value}
  oninput={onInput}
  onkeydown={onKeydown}
></textarea>
