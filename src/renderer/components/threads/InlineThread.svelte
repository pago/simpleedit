<script lang="ts">
  import { agentThreadsStore } from '../../stores/agentThreads.svelte'
  import { anchorContextLabel, anchorLabel } from '../../lib/thread-labels'
  import ThreadBody from './ThreadBody.svelte'

  /** A thread shown in an editor, in a view zone under its anchor (`lib/thread-zones.ts`). */
  interface Props {
    threadId: string
    onclose: () => void
    /** Show it in the session's Threads panel instead. */
    onreveal: () => void
  }

  let { threadId, onclose, onreveal }: Props = $props()

  let thread = $derived(agentThreadsStore.get(threadId))
  let root: HTMLDivElement | undefined = $state()
  // Hidden workspaces stay mounted and Monaco hides zones scrolled out of view;
  // either way the zone stops intersecting, and an unseen answer stays unread.
  let visible = $state(false)

  $effect(() => {
    if (!root) return
    const io = new IntersectionObserver((entries) => {
      visible = entries.some((e) => e.isIntersecting)
    })
    io.observe(root)
    return () => io.disconnect()
  })
</script>

{#if thread}
  {@const contextLabel = anchorContextLabel(thread.anchor)}
  <div
    bind:this={root}
    data-inline-thread={thread.id}
    class="my-1 mr-4 rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 font-sans shadow-lg"
  >
    <div class="mb-1 flex items-center gap-2">
      <span class="truncate font-mono text-[11px] text-zinc-400">{anchorLabel(thread.anchor)}</span>
      {#if contextLabel}
        <span class="flex-none rounded bg-zinc-800 px-1 font-mono text-[10px] text-zinc-500">{contextLabel}</span>
      {/if}
      <span class="flex-1"></span>
      <button class="flex-none text-[11px] text-zinc-500 hover:text-blue-300 hover:underline" onclick={onreveal}>
        Show in panel
      </button>
      <button
        class="flex h-5 w-5 flex-none items-center justify-center rounded text-zinc-500 hover:bg-zinc-700 hover:text-zinc-200"
        aria-label="Close thread"
        onclick={onclose}
      >
        ×
      </button>
    </div>
    <ThreadBody {thread} {visible} onescape={onclose} />
  </div>
{/if}
