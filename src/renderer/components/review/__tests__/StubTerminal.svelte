<script lang="ts">
  let { terminalId, active = true }: { terminalId: string; active?: boolean } = $props()
</script>

<div data-testid="stub-terminal" data-terminal-id={terminalId} data-active={active}></div>
