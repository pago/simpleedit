<script lang="ts">
  import type { BaseComponentProps } from '@json-render/svelte'
  import { getActionContext } from '@json-render/svelte'
  import type { z } from 'zod'
  import type { FileListProps as FileListPropsSchema, ActionRef } from '../../../shared/gen-ui-catalog'
  import { actionRefToBinding } from './action-ref'

  type FileListProps = z.infer<typeof FileListPropsSchema>

  let { props }: BaseComponentProps<FileListProps> = $props()

  const actions = getActionContext()

  const STATUS_STYLES: Record<NonNullable<FileListProps['items'][number]['status']>, string> = {
    added: 'bg-green-900/40 text-green-300 border-green-800/60',
    modified: 'bg-amber-900/40 text-amber-300 border-amber-800/60',
    deleted: 'bg-red-900/40 text-red-300 border-red-800/60',
    renamed: 'bg-blue-900/40 text-blue-300 border-blue-800/60',
    error: 'bg-red-900/40 text-red-300 border-red-800/60',
    ok: 'bg-zinc-800 text-zinc-400 border-zinc-700',
  }

  function dispatch(action: ActionRef): void {
    void actions.execute(actionRefToBinding(action))
  }
</script>

<div class="flex flex-col gap-1">
  {#if props.title}
    <div class="text-xs font-medium text-zinc-400">{props.title}</div>
  {/if}
  <ul class="flex flex-col divide-y divide-zinc-800/60 overflow-hidden rounded border border-zinc-800 bg-zinc-900/40">
    {#each props.items as item (item.path)}
      {@const clickable = item.action !== undefined}
      <li>
        <button
          type="button"
          class="flex w-full items-start gap-2 px-2 py-1.5 text-left text-xs disabled:cursor-default {clickable
            ? 'hover:bg-zinc-800/80'
            : 'cursor-default'}"
          disabled={!clickable}
          onclick={() => item.action && dispatch(item.action)}
        >
          {#if item.status}
            <span
              class="flex-none rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide {STATUS_STYLES[
                item.status
              ]}"
            >
              {item.status}
            </span>
          {/if}
          <!-- The path stays one line (it has a tooltip); `detail` carries a
               clause about why the file is here, so it wraps in full below. -->
          <span class="flex min-w-0 flex-1 flex-col gap-0.5">
            <span class="truncate font-mono text-zinc-200" title={item.path}>{item.path}</span>
            {#if item.detail}
              <span class="whitespace-pre-wrap break-words text-zinc-500">{item.detail}</span>
            {/if}
          </span>
        </button>
      </li>
    {/each}
  </ul>
</div>
