<script lang="ts">
  /**
   * Transparent wrapper around every primitive in a composed panel, tagging it
   * with the spec key so a text selection can be traced back to its block
   * (see `block-context.ts`). `display: contents` keeps it invisible to layout.
   */
  import type { Snippet } from 'svelte'
  import type { ComponentRenderer } from '@json-render/svelte'
  import type { UIElement } from '@json-render/core'
  import { BLOCK_ID_PROP } from './block-context'

  interface Props {
    Inner: ComponentRenderer
    blockType: string
    element: UIElement
    children?: Snippet
    emit: (event: string) => void
    on: (event: string) => unknown
    bindings?: Record<string, string>
    loading?: boolean
  }

  let { Inner, blockType, element, children, ...rest }: Props = $props()

  let blockId = $derived(
    typeof (element.props as Record<string, unknown>)[BLOCK_ID_PROP] === 'string'
      ? ((element.props as Record<string, unknown>)[BLOCK_ID_PROP] as string)
      : null,
  )
</script>

{#if blockId}
  <div data-block-id={blockId} data-block-type={blockType} style="display: contents">
    <Inner {element} {...rest}>{@render children?.()}</Inner>
  </div>
{:else}
  <Inner {element} {...rest}>{@render children?.()}</Inner>
{/if}
