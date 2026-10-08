<script lang="ts">
  /** A session's agent threads: open ones first, resolved ones folded away below. */
  import { untrack } from 'svelte'
  import { agentThreadsStore } from '../renderer/stores/agentThreads.svelte'
  import type { AgentThread } from '../shared/agent-threads'
  import ThreadCard from './ThreadCard.svelte'

  interface Props {
    sessionId: string
    /** The pane is shown and its screen is on top. */
    active: boolean
    /** Expand this thread and scroll to it: a tap on a thread-reply notification. A new object per tap. */
    openThread?: { threadId: string }
    /** Show a thread's line in the Changes pane. Resolves false when the diff doesn't hold it. */
    onjump?: (thread: AgentThread) => Promise<boolean>
  }

  let { sessionId, active, openThread, onjump }: Props = $props()

  let threads = $derived(agentThreadsStore.forSession(sessionId))
  let open = $derived(threads.filter((t) => t.status === 'open'))
  let resolved = $derived(threads.filter((t) => t.status === 'resolved'))
  let expanded = $state<Set<string>>(new Set())
  let showResolved = $state(false)
  let root = $state<HTMLDivElement>()

  function toggle(id: string): void {
    const next = new Set(expanded)
    if (!next.delete(id)) next.add(id)
    expanded = next
  }

  /** Waiting to be scrolled to: the thread may not have reached the mirror yet, or the pane may still be hidden. */
  let pending = $state<string | null>(null)

  $effect(() => {
    if (!openThread) return
    const id = openThread.threadId
    untrack(() => {
      expanded = new Set(expanded).add(id)
      pending = id
    })
  })

  $effect(() => {
    if (!pending || !active) return
    const t = threads.find((x) => x.id === pending)
    if (!t) return
    if (t.status === 'resolved' && !showResolved) {
      showResolved = true
      return
    }
    root?.querySelector(`[data-thread-id="${t.id}"]`)?.scrollIntoView({ block: 'start' })
    pending = null
  })
</script>

<div class="h-full min-h-0 overflow-y-auto" data-testid="threads-pane" bind:this={root}>
  {#if threads.length === 0}
    <p class="px-4 py-6 text-sm leading-relaxed text-zinc-500">
      No threads yet. Tap a line in Changes, or select code on the desktop and use Discuss with Agent, to start one with this session's agent.
    </p>
  {:else}
    <ul>
      {#each open as t (t.id)}
        <ThreadCard
          thread={t}
          expanded={expanded.has(t.id)}
          visible={active}
          ontoggle={() => toggle(t.id)}
          onjump={onjump && (() => onjump(t))}
        />
      {/each}
    </ul>
    {#if resolved.length > 0}
      <button
        type="button"
        class="min-h-11 w-full px-3 text-left text-xs text-zinc-500 active:bg-zinc-900"
        aria-expanded={showResolved}
        onclick={() => (showResolved = !showResolved)}
      >
        {showResolved ? '▾' : '▸'} Resolved ({resolved.length})
      </button>
      {#if showResolved}
        <ul>
          {#each resolved as t (t.id)}
            <ThreadCard
              thread={t}
              expanded={expanded.has(t.id)}
              visible={active}
              ontoggle={() => toggle(t.id)}
              onjump={onjump && (() => onjump(t))}
            />
          {/each}
        </ul>
      {/if}
    {/if}
  {/if}
</div>
