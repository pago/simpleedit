<script lang="ts">
  let { originalContent, modifiedContent }: { originalContent: string; modifiedContent: string } = $props()
</script>

<div data-testid="prompt-diff"><pre data-testid="diff-original">{originalContent}</pre><pre data-testid="diff-modified">{modifiedContent}</pre></div>
