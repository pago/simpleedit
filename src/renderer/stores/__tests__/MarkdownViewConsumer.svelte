<script lang="ts">
  import { markdownViewStore } from '../markdownView.svelte'

  let { path }: { path: string } = $props()

  // Mirrors how MarkdownView/TabActions read the mode: a derived over
  // markdownViewStore.get(path). This is the read path the lock bug breaks.
  const mode = $derived(markdownViewStore.get(path))
</script>

<output data-testid="mode">{mode}</output>
