<script lang="ts">
  /**
   * Gen-UI `DiffBlock` — a unified diff the agent supplied as text.
   *
   * Deliberately not Monaco: a Monaco diff editor needs the before and after
   * file versions, which means a checked-out repo. Rendering the diff text
   * directly is what lets a panel tour a PR nobody has fetched.
   */
  import type { BaseComponentProps } from '@json-render/svelte'
  import { getActionContext } from '@json-render/svelte'
  import type { z } from 'zod'
  import type { DiffBlockProps as DiffBlockPropsSchema, ActionRef } from '../../../shared/gen-ui-catalog'
  import { parseUnifiedDiff } from '../../lib/parseDiff'
  import UnifiedDiffView from '../diff/UnifiedDiffView.svelte'
  import { actionRefToBinding } from './action-ref'

  type DiffBlockProps = z.infer<typeof DiffBlockPropsSchema>

  let { props }: BaseComponentProps<DiffBlockProps> = $props()

  const actions = getActionContext()

  let files = $derived(parseUnifiedDiff(props.diff))

  function linkFor(path: string): { label?: string; action: ActionRef } | undefined {
    return props.fileActions?.find((a) => a.path === path)
  }

  function dispatch(action: ActionRef): void {
    void actions.execute(actionRefToBinding(action))
  }
</script>

<div class="flex min-w-0 flex-col gap-1">
  {#if props.title}
    <div class="text-xs font-medium text-zinc-400">{props.title}</div>
  {/if}
  <UnifiedDiffView {files} language={props.language} emptyLabel="No parsable diff content.">
    {#snippet fileHeaderExtra(f)}
      {@const link = linkFor(f.path)}
      {#if link}
        <button
          type="button"
          class="flex-none rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-400 hover:border-blue-500 hover:bg-blue-500/15 hover:text-blue-200"
          onclick={() => dispatch(link.action)}
        >
          {link.label ?? 'open file'}
        </button>
      {/if}
    {/snippet}
  </UnifiedDiffView>
</div>
