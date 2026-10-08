<script lang="ts">
  /** A session's agent threads: open ones first, resolved ones folded away below. */
  import { agentThreadsStore } from '../renderer/stores/agentThreads.svelte'
  import ThreadCard from './ThreadCard.svelte'

  interface Props {
    sessionId: string
    /** The pane is shown and its screen is on top. */
    active: boolean
  }

  let { sessionId, active }: Props = $props()

  let threads = $derived(agentThreadsStore.forSession(sessionId))
  let open = $derived(threads.filter((t) => t.status === 'open'))
  let resolved = $derived(threads.filter((t) => t.status === 'resolved'))
  let expanded = $state<Set<string>>(new Set())
  let showResolved = $state(false)

  function toggle(id: string): void {
    const next = new Set(expanded)
    if (!next.delete(id)) next.add(id)
    expanded = next
  }
</script>

<div class="h-full min-h-0 overflow-y-auto" data-testid="threads-pane">
  {#if threads.length === 0}
    <p class="px-4 py-6 text-sm leading-relaxed text-zinc-500">
      No threads yet. Select code on the desktop and use Discuss with Agent to start one with this session's agent.
    </p>
  {:else}
    <ul>
      {#each open as t (t.id)}
        <ThreadCard thread={t} expanded={expanded.has(t.id)} visible={active} ontoggle={() => toggle(t.id)} />
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
            <ThreadCard thread={t} expanded={expanded.has(t.id)} visible={active} ontoggle={() => toggle(t.id)} />
          {/each}
        </ul>
      {/if}
    {/if}
  {/if}
</div>
