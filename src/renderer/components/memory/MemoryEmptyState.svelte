<script lang="ts">
  interface Props {
    memoryDir: string
  }

  let { memoryDir }: Props = $props()

  let copied = $state(false)
  let copiedTimer: ReturnType<typeof setTimeout> | undefined

  async function copyPath(): Promise<void> {
    try {
      await navigator.clipboard.writeText(memoryDir)
      copied = true
      clearTimeout(copiedTimer)
      copiedTimer = setTimeout(() => (copied = false), 1500)
    } catch {
      // The path is shown in full, so the user can still select it by hand.
    }
  }

  $effect(() => () => clearTimeout(copiedTimer))
</script>

<div class="flex flex-col gap-2 px-2 py-4 text-xs text-zinc-400" data-testid="memory-empty-state">
  <p class="font-medium text-zinc-300">No memories yet</p>
  <p class="text-[11px] text-zinc-500">Claude hasn't saved anything for this project. It will live in:</p>
  <div class="flex items-start gap-1">
    <code class="min-w-0 flex-1 select-text break-all rounded bg-zinc-800 px-1.5 py-1 font-mono text-[10px] text-zinc-300">
      {memoryDir}
    </code>
    <button
      class="shrink-0 rounded px-1.5 py-1 text-[10px] text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
      onclick={copyPath}
      title="Copy path"
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  </div>
</div>
