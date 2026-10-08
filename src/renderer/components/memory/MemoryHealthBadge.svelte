<script lang="ts">
  import { memoryIssueSeverity } from '../../../shared/memory-health'
  import { memoryViewStore } from '../../stores/memoryView.svelte'
  import MemoryHealthList from './MemoryHealthList.svelte'

  interface Props {
    sessionId: string
    memoryDir: string
  }

  let { sessionId, memoryDir }: Props = $props()

  let open = $state(false)
  let buttonEl = $state<HTMLButtonElement | undefined>()
  let popoverEl = $state<HTMLElement | null>(null)

  let issues = $derived(memoryViewStore.health(memoryDir)?.report?.issues ?? [])
  let warnings = $derived(issues.filter((i) => memoryIssueSeverity(i.kind) === 'warning').length)

  function handleWindowPointerDown(e: PointerEvent): void {
    if (!open) return
    const target = e.target as Node
    if (popoverEl?.contains(target) || buttonEl?.contains(target)) return
    open = false
  }

  function handleWindowKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape' && open) {
      open = false
      buttonEl?.focus()
    }
  }
</script>

<svelte:window onpointerdown={handleWindowPointerDown} onkeydown={handleWindowKeydown} />

<div class="relative">
  <button
    bind:this={buttonEl}
    class="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
    onclick={() => (open = !open)}
    aria-haspopup="dialog"
    aria-expanded={open}
    aria-label="Memory health: {issues.length} {issues.length === 1 ? 'issue' : 'issues'}"
    title="Memory health"
  >
    <span>Health</span>
    <span
      data-testid="memory-health-count"
      class="rounded px-1 py-0.5 text-[10px] {warnings > 0
        ? 'bg-amber-900/60 text-amber-300'
        : issues.length > 0
          ? 'bg-sky-900/60 text-sky-300'
          : 'bg-zinc-700 text-zinc-400'}"
    >
      {issues.length}
    </span>
  </button>

  {#if open}
    <div
      bind:this={popoverEl}
      class="absolute right-0 top-full z-30 mt-1 max-h-96 w-80 overflow-y-auto rounded border border-zinc-700 bg-zinc-900 py-2 shadow-xl"
      role="dialog"
      aria-label="Memory health"
    >
      <MemoryHealthList {sessionId} {memoryDir} onselect={() => (open = false)} />
    </div>
  {/if}
</div>
