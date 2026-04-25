<script lang="ts">
  import type { BaseComponentProps } from '@json-render/svelte'
  import type { z } from 'zod'
  import type { RowProps as RowPropsSchema } from '../../../shared/gen-ui-catalog'

  type RowProps = z.infer<typeof RowPropsSchema>

  let { props, children }: BaseComponentProps<RowProps> = $props()

  const GAP_STYLES: Record<NonNullable<RowProps['gap']>, string> = {
    sm: 'gap-2',
    md: 'gap-3',
    lg: 'gap-4',
  }
</script>

<div class="flex items-center {GAP_STYLES[props.gap ?? 'md']} {props.wrap ? 'flex-wrap' : ''}">
  {@render children?.()}
</div>
