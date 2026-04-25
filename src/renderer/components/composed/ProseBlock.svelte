<script lang="ts">
  import type { BaseComponentProps } from '@json-render/svelte'
  import type { z } from 'zod'
  import type { ProseBlockProps as ProseBlockPropsSchema } from '../../../shared/gen-ui-catalog'

  type ProseBlockProps = z.infer<typeof ProseBlockPropsSchema>

  let { props }: BaseComponentProps<ProseBlockProps> = $props()
</script>

<!--
  TODO: wire a real markdown renderer (e.g. `marked` + DOMPurify) so the
  content is actually parsed. For Phase 1 we render the string as-is and
  rely on the LLM to emit pre-formatted HTML/text. The `prose` classes are
  retained so visuals upgrade automatically once a parser lands.
-->
<div class="prose prose-invert prose-sm max-w-none text-zinc-300">
  {@html props.content}
</div>
