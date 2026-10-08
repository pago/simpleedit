<script lang="ts">
  import { hasUnread, type AgentThread } from '../../../shared/agent-threads'
  import { anchorContextLabel, anchorLabel } from '../../lib/thread-labels'
  import ThreadBody from './ThreadBody.svelte'

  interface Props {
    thread: AgentThread
    expanded: boolean
    /** The panel is on screen. Hidden workspaces stay mounted, and an answer nobody saw isn't read. */
    visible: boolean
    ontoggle: () => void
    onopen: (thread: AgentThread) => void
  }

  let { thread, expanded, visible, ontoggle, onopen }: Props = $props()

  let unread = $derived(hasUnread(thread))
  let contextLabel = $derived(anchorContextLabel(thread.anchor))
</script>

<li data-thread-id={thread.id} class="border-b border-zinc-800 {thread.status === 'resolved' ? 'opacity-70' : ''}">
  <div class="flex items-center gap-1 py-0.5 pl-1 pr-2">
    <button
      class="flex h-6 w-6 flex-none items-center justify-center rounded text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
      aria-expanded={expanded}
      aria-label={expanded ? 'Collapse thread' : 'Expand thread'}
      onclick={ontoggle}
    >
      {expanded ? '▾' : '▸'}
    </button>
    <button
      class="min-w-0 truncate text-left font-mono text-[11px] text-zinc-300 hover:text-blue-300 hover:underline"
      title="Open {anchorLabel(thread.anchor)}"
      onclick={() => onopen(thread)}
    >
      {anchorLabel(thread.anchor)}
    </button>
    {#if thread.anchor.orphaned}
      <span class="flex-none text-[10px] text-amber-300/80" title="The commented code has moved or changed">moved</span>
    {/if}
    {#if contextLabel}
      <span class="flex-none rounded bg-zinc-800 px-1 font-mono text-[10px] text-zinc-500">{contextLabel}</span>
    {/if}
    {#if thread.status === 'resolved'}
      <span class="flex-none text-[10px] text-zinc-500">resolved</span>
    {/if}
    {#if unread}
      <span class="h-1.5 w-1.5 flex-none rounded-full bg-blue-400" aria-label="Unread reply"></span>
    {/if}
    <!-- The rest of the row toggles too; the chevron is the accessible control. -->
    <button class="h-6 min-w-4 flex-1 self-stretch" tabindex="-1" aria-hidden="true" onclick={ontoggle}></button>
  </div>

  {#if !expanded}
    {@const last = thread.messages.at(-1)}
    {#if last}
      <button class="block w-full truncate px-6 pb-1.5 text-left text-[11px] text-zinc-500" onclick={ontoggle}>
        {last.author === 'agent' ? 'Agent: ' : ''}{last.body}
      </button>
    {/if}
  {:else}
    <div class="px-3 pb-2">
      <ThreadBody {thread} {visible} />
    </div>
  {/if}
</li>
