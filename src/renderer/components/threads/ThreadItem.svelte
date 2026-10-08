<script lang="ts">
  import { hasUnread, type AgentThread, type ThreadMessage } from '../../../shared/agent-threads'
  import { agentThreadsStore } from '../../stores/agentThreads.svelte'
  import { renderMarkdown } from '../../lib/markdown'
  import { anchorContextLabel, anchorLabel, deliveryInfo, implicitAnswerIds, type DeliveryInfo } from '../../lib/thread-labels'

  interface Props {
    thread: AgentThread
    expanded: boolean
    /** The panel is on screen. Hidden workspaces stay mounted, and an answer nobody saw isn't read. */
    visible: boolean
    ontoggle: () => void
    onopen: (thread: AgentThread) => void
  }

  let { thread, expanded, visible, ontoggle, onopen }: Props = $props()

  let draft = $state('')
  let sending = $state(false)
  let error = $state<string | null>(null)
  let confirming = $state<'remove' | null>(null)

  let unread = $derived(hasUnread(thread))
  let implicit = $derived(implicitAnswerIds(thread))
  let contextLabel = $derived(anchorContextLabel(thread.anchor))

  // Showing a thread expanded is reading it, so newly arrived answers are read too.
  $effect(() => {
    if (visible && expanded && unread) agentThreadsStore.markRead(thread.id)
  })

  function message(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
  }

  async function run(action: () => Promise<unknown>): Promise<boolean> {
    error = null
    try {
      await action()
      return true
    } catch (err) {
      error = message(err)
      return false
    }
  }

  async function submit(): Promise<void> {
    const body = draft.trim()
    if (!body || sending) return
    sending = true
    if (await run(() => agentThreadsStore.append(thread.id, body))) draft = ''
    sending = false
  }

  function onComposerKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void submit()
    }
  }

  async function retry(messageId: string): Promise<void> {
    await run(async () => {
      if (!(await agentThreadsStore.retry(thread.sessionId, messageId))) throw new Error("It couldn't be queued again.")
    })
  }

  let copiedId = $state<string | null>(null)

  async function copy(m: ThreadMessage): Promise<void> {
    await run(async () => {
      await navigator.clipboard.writeText(m.body)
      copiedId = m.id
    })
  }

  async function forceSend(): Promise<void> {
    await run(() => agentThreadsStore.forceSend(thread.sessionId))
  }

  const TONE: Record<DeliveryInfo['tone'], string> = {
    muted: 'text-zinc-500',
    waiting: 'text-amber-300/80',
    ok: 'text-emerald-400/80',
    error: 'text-red-300',
  }
  const PROSE =
    'prose prose-invert prose-sm max-w-none text-[12px] leading-relaxed text-zinc-300 prose-p:my-1 prose-ul:my-1 prose-li:my-0.5 prose-pre:my-1 prose-code:text-[11px]'
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
    <div class="space-y-2 px-3 pb-2">
      {#each thread.messages as m (m.id)}
        {@const info = deliveryInfo(m)}
        <div class="rounded {m.author === 'agent' ? 'bg-zinc-800/60' : ''} px-2 py-1">
          <div class="text-[10px] font-medium uppercase tracking-wide text-zinc-500">
            {m.author === 'agent' ? 'Agent' : 'You'}
          </div>
          {#if m.author === 'agent'}
            <div class={PROSE}>{@html renderMarkdown(m.body)}</div>
            {#if implicit.has(m.id)}
              <div class="mt-0.5 text-[10px] italic text-zinc-500">from the agent's final message</div>
            {/if}
          {:else}
            <p class="whitespace-pre-wrap break-words text-[12px] text-zinc-200">{m.body}</p>
          {/if}
          {#if info}
            <div class="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] {TONE[info.tone]}">
              <span>{info.label}</span>
              {#if info.action === 'retry'}
                <button class="rounded border border-zinc-700 px-1.5 text-zinc-300 hover:bg-zinc-700" onclick={() => retry(m.id)}>
                  Retry
                </button>
              {:else if info.action === 'force-send'}
                <button class="rounded border border-zinc-700 px-1.5 text-zinc-300 hover:bg-zinc-700" onclick={() => copy(m)}>
                  {copiedId === m.id ? 'Copied' : 'Copy'}
                </button>
                <button class="rounded border border-zinc-700 px-1.5 text-zinc-300 hover:bg-zinc-700" onclick={forceSend}>
                  My prompt is empty, send
                </button>
              {/if}
            </div>
          {/if}
        </div>
      {/each}

      <textarea
        bind:value={draft}
        class="w-full resize-none rounded border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-blue-500"
        rows="2"
        placeholder={thread.status === 'resolved' ? 'Reply to reopen…' : 'Reply…'}
        aria-label="Reply to thread"
        onkeydown={onComposerKeydown}
      ></textarea>
      {#if error}
        <p role="alert" class="text-[11px] text-red-300">{error}</p>
      {/if}
      <div class="flex items-center gap-1.5">
        <button
          class="rounded bg-orange-600 px-2 py-0.5 text-[11px] text-white hover:bg-orange-500 disabled:opacity-40"
          disabled={!draft.trim() || sending}
          onclick={submit}
        >
          Send
        </button>
        {#if thread.status === 'open'}
          <button
            class="rounded px-1.5 py-0.5 text-[11px] text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
            onclick={() => run(() => agentThreadsStore.setStatus(thread.id, 'resolved'))}
          >
            Resolve
          </button>
        {:else}
          <button
            class="rounded px-1.5 py-0.5 text-[11px] text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
            onclick={() => run(() => agentThreadsStore.setStatus(thread.id, 'open'))}
          >
            Reopen
          </button>
        {/if}
        <span class="flex-1"></span>
        {#if confirming === 'remove'}
          <button
            class="rounded px-1.5 py-0.5 text-[11px] text-red-300 hover:bg-red-500/20"
            onclick={() => run(() => agentThreadsStore.remove(thread.id))}
          >
            Remove thread
          </button>
          <button class="px-1 text-[11px] text-zinc-400 hover:text-zinc-200" onclick={() => (confirming = null)}>Cancel</button>
        {:else}
          <button
            class="rounded px-1.5 py-0.5 text-[11px] text-zinc-500 hover:bg-zinc-700 hover:text-zinc-300"
            onclick={() => (confirming = 'remove')}
          >
            Remove
          </button>
        {/if}
      </div>
    </div>
  {/if}
</li>
