<script lang="ts">
  import type { BaseComponentProps } from '@json-render/svelte'
  import type { z } from 'zod'
  import type { CodeSnippetProps as CodeSnippetPropsSchema } from '../../../shared/gen-ui-catalog'

  type CodeSnippetProps = z.infer<typeof CodeSnippetPropsSchema>

  let { props }: BaseComponentProps<CodeSnippetProps> = $props()

  // Each line is roughly 1.5 * 0.75rem font-size = 1.125rem; allow a small fudge.
  const maxHeight = $derived(props.maxLines !== undefined ? `${props.maxLines * 1.4}em` : undefined)

  const lines = $derived(props.lineNumbers ? props.code.split('\n') : null)
</script>

<!--
  TODO: replace the plain `<pre><code>` with a Shiki (or similar) highlighter
  so the `language` prop actually drives token colors. Phase 1 ships a
  zinc-on-zinc monospace block — visually consistent with the rest of the IDE
  but unstyled token-wise.
-->
<div class="flex flex-col gap-1">
  {#if props.annotation}
    <div class="text-[11px] italic text-zinc-500">{props.annotation}</div>
  {/if}
  <pre
    class="overflow-auto rounded border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs leading-relaxed text-zinc-200"
    style:max-height={maxHeight}
    data-language={props.language}><code>{#if lines}{#each lines as line, i (i)}<span
            class="select-none pr-3 text-right text-zinc-600 inline-block"
            style:min-width="2.5em">{i + 1}</span>{line}{'\n'}{/each}{:else}{props.code}{/if}</code></pre>
</div>
