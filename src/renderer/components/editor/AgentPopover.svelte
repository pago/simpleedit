<script lang="ts">
  import type { AgentContext } from '../../lib/agent-message'
  import { buildAgentMessage } from '../../lib/agent-message'
  import type { AgentTabInfo } from '../../stores/agentTerminals.svelte'

  interface Props {
    x: number
    y: number
    context: AgentContext
    terminals: AgentTabInfo[]
    onclose: () => void
    onsend: (terminalId: string | 'new', message: string) => void
  }

  let { x, y, context, terminals, onclose, onsend }: Props = $props()

  let message = $state('')
  let selectedTerminalId = $state<string | 'new'>(terminals.length > 0 ? terminals[0].id : 'new')
  let textareaEl: HTMLTextAreaElement | undefined = $state()
  let popoverEl: HTMLDivElement | undefined = $state()

  $effect(() => {
    textareaEl?.focus()
  })

  $effect(() => {
    function onPointerDown(e: PointerEvent) {
      if (popoverEl && !popoverEl.contains(e.target as Node)) {
        onclose()
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  })

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      onclose()
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  function submit(): void {
    const trimmed = message.trim()
    if (!trimmed) return
    onsend(selectedTerminalId, buildAgentMessage(context, trimmed))
  }

  function contextLabel(ctx: AgentContext): string {
    const file = ctx.filePath.split('/').at(-1) ?? ctx.filePath
    const lines = `lines ${ctx.lineRange[0]}-${ctx.lineRange[1]}`
    if (ctx.kind === 'editor') {
      return `${file} · ${lines}`
    }
    const ref = ctx.commitHash ? ctx.commitHash.slice(0, 7) : 'uncommitted'
    return `${file} · ${ref} · ${ctx.side} · ${lines}`
  }
</script>

<div
  bind:this={popoverEl}
  class="fixed z-50 w-80 rounded-lg border border-zinc-700 bg-zinc-900 shadow-2xl shadow-black/60"
  style:left="{x}px"
  style:top="{y}px"
>
  <div class="border-b border-zinc-800 px-3 py-1.5">
    <span class="font-mono text-[10px] text-zinc-500">{contextLabel(context)}</span>
  </div>

  <div class="p-2">
    <textarea
      bind:this={textareaEl}
      bind:value={message}
      class="w-full resize-none rounded border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-blue-500"
      rows="3"
      placeholder="Discuss this with agent..."
      onkeydown={handleKeydown}
    ></textarea>

    <div class="mt-2 flex items-center gap-2">
      <select
        bind:value={selectedTerminalId}
        class="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-300 outline-none focus:border-blue-500"
      >
        {#each terminals as t (t.id)}
          <option value={t.id}>✦ {t.label}</option>
        {/each}
        <option value="new">✦ New Agent</option>
      </select>

      <button
        class="rounded bg-orange-600 px-3 py-1 text-xs text-white hover:bg-orange-500 disabled:opacity-40"
        disabled={!message.trim()}
        onclick={submit}
      >
        Send
      </button>
    </div>
  </div>
</div>
