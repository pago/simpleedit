<script lang="ts">
  import { untrack } from 'svelte'
  import type { AgentThread } from '../../../shared/agent-threads'
  import { agentThreadsStore } from '../../stores/agentThreads.svelte'
  import ThreadItem from './ThreadItem.svelte'

  interface Props {
    sessionId: string
    visible: boolean
    onopen: (thread: AgentThread) => void
  }

  let { sessionId, visible, onopen }: Props = $props()

  let threads = $derived(agentThreadsStore.forSession(sessionId))
  let open = $derived(threads.filter((t) => t.status === 'open'))
  let resolved = $derived(threads.filter((t) => t.status === 'resolved'))
  let expanded = $state<Set<string>>(new Set())
  let showResolved = $state(false)

  $effect(() => {
    const focus = agentThreadsStore.focusFor(sessionId)
    if (!focus) return
    expanded = new Set([...untrack(() => expanded), focus])
    agentThreadsStore.takeFocus(sessionId)
  })

  function toggle(id: string): void {
    const next = new Set(expanded)
    if (!next.delete(id)) next.add(id)
    expanded = next
  }
</script>

<section class="flex h-full flex-col" aria-label="Threads">
  <div class="flex flex-none items-center gap-2 border-b border-zinc-800 px-3 py-1.5">
    <span class="text-xs font-medium uppercase tracking-wider text-zinc-400">Threads</span>
    <span class="text-[11px] text-zinc-600">{open.length} open</span>
  </div>

  <div class="min-h-0 flex-1 overflow-y-auto">
    {#if threads.length === 0}
      <p class="px-3 py-4 text-[11px] leading-relaxed text-zinc-500">
        No threads yet. Select code and use Discuss with Agent (⌘I) to start one with this session's agent.
      </p>
    {:else}
      <ul>
        {#each open as t (t.id)}
          <ThreadItem thread={t} expanded={expanded.has(t.id)} {visible} ontoggle={() => toggle(t.id)} {onopen} />
        {/each}
      </ul>
      {#if resolved.length > 0}
        <button
          class="w-full px-3 py-1.5 text-left text-[11px] text-zinc-500 hover:text-zinc-300"
          aria-expanded={showResolved}
          onclick={() => (showResolved = !showResolved)}
        >
          {showResolved ? '▾' : '▸'} Resolved ({resolved.length})
        </button>
        {#if showResolved}
          <ul>
            {#each resolved as t (t.id)}
              <ThreadItem thread={t} expanded={expanded.has(t.id)} {visible} ontoggle={() => toggle(t.id)} {onopen} />
            {/each}
          </ul>
        {/if}
      {/if}
    {/if}
  </div>
</section>
