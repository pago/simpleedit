<script lang="ts">
  import type { BaseComponentProps } from '@json-render/svelte'
  import type { z } from 'zod'
  import type { ProseBlockProps as ProseBlockPropsSchema } from '../../../shared/gen-ui-catalog'
  import { renderMarkdown } from '../../lib/markdown'

  type ProseBlockProps = z.infer<typeof ProseBlockPropsSchema>

  let { props }: BaseComponentProps<ProseBlockProps> = $props()

  const html = $derived(renderMarkdown(props.content))
</script>

<div class="prose prose-invert prose-sm max-w-none text-zinc-300">
  {@html html}
</div>
