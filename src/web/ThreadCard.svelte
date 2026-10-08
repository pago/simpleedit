<script lang="ts">
  /**
   * One agent thread on the phone: the desktop's `ThreadItem`, laid out for a
   * thumb. Every change is an op to main through the shared store, which is
   * also the only path to the agent: main decides when a message is written to
   * the session (`thread-delivery.ts`), so nothing here touches a PTY — a
   * comment sent from here while the desk has a draft in the terminal is held
   * like any other.
   *
   * Enter adds a newline rather than sending: a phone keyboard's return key is
   * how a paragraph is typed, so Send is a button.
   */
  import { hasUnread, type AgentThread, type ThreadMessage } from '../shared/agent-threads'
  import { agentThreadsStore } from '../renderer/stores/agentThreads.svelte'
  import { renderMarkdown } from '../renderer/lib/markdown'
  import { anchorContextLabel, anchorLabel, deliveryInfo, implicitAnswerIds, type DeliveryInfo } from '../renderer/lib/thread-labels'
  import { copyText } from './lib/copy-text'

  interface Props {
    thread: AgentThread
    expanded: boolean
    /** On screen: the pane is shown and its screen is on top. A hidden expanded thread reads nothing. */
    visible: boolean
    ontoggle: () => void
  }

  let { thread, expanded, visible, ontoggle }: Props = $props()

  let draft = $state('')
  let sending = $state(false)
  let error = $state<string | null>(null)
  let copiedId = $state<string | null>(null)

  let unread = $derived(hasUnread(thread))
  let implicit = $derived(implicitAnswerIds(thread))
  let contextLabel = $derived(anchorContextLabel(thread.anchor))
  let last = $derived(thread.messages.at(-1))

  // Showing a thread expanded is reading it, so answers that arrive while it is open are read too.
  $effect(() => {
    if (expanded && visible && unread) agentThreadsStore.markRead(thread.id)
  })

  async function run(action: () => Promise<unknown>): Promise<boolean> {
    error = null
    try {
      await action()
      return true
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
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

  async function retry(messageId: string): Promise<void> {
    await run(async () => {
      if (!(await agentThreadsStore.retry(thread.sessionId, messageId))) throw new Error("It couldn't be queued again.")
    })
  }

  async function forceSend(): Promise<void> {
    await run(() => agentThreadsStore.forceSend(thread.sessionId))
  }

  async function copy(m: ThreadMessage): Promise<void> {
    if (await run(() => copyText(m.body))) copiedId = m.id
  }

  const TONE: Record<DeliveryInfo['tone'], string> = {
    muted: 'text-zinc-500',
    waiting: 'text-amber-300/80',
    ok: 'text-emerald-400/80',
    error: 'text-red-300',
  }
  const PROSE =
    'prose prose-invert prose-sm max-w-none text-[13px] leading-relaxed text-zinc-300 prose-p:my-1 prose-ul:my-1 prose-li:my-0.5 prose-pre:my-1 prose-code:text-[12px]'
  const ACTION = 'min-h-9 rounded-md border border-zinc-700 px-3 text-xs text-zinc-200 active:bg-zinc-800'
</script>

<li
  class="border-b border-zinc-800 {thread.status === 'resolved' ? 'opacity-70' : ''}"
  data-testid="thread-card"
  data-thread-id={thread.id}
>
  <button
    type="button"
    class="flex min-h-12 w-full items-center gap-2 px-3 py-2 text-left active:bg-zinc-900"
    aria-expanded={expanded}
    onclick={ontoggle}
    data-testid="thread-toggle"
  >
    <span class="flex-none text-[11px] text-zinc-500" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
    <span class="min-w-0 flex-1">
      <span class="block truncate font-mono text-xs text-zinc-200">{anchorLabel(thread.anchor)}</span>
      {#if !expanded && last}
        <span class="mt-0.5 block truncate text-[11px] text-zinc-500">
          {last.author === 'agent' ? 'Agent: ' : ''}{last.body}
        </span>
      {/if}
    </span>
    {#if thread.anchor.orphaned}
      <span class="flex-none text-[10px] text-amber-300/80">moved</span>
    {/if}
    {#if contextLabel}
      <span class="flex-none rounded bg-zinc-800 px-1 font-mono text-[10px] text-zinc-500">{contextLabel}</span>
    {/if}
    {#if thread.status === 'resolved'}
      <span class="flex-none text-[10px] text-zinc-500">resolved</span>
    {/if}
    {#if unread}
      <span class="h-2 w-2 flex-none rounded-full bg-blue-400" aria-label="Unread reply" data-testid="thread-unread"></span>
    {/if}
  </button>

  {#if expanded}
    <div class="space-y-2 px-3 pb-3">
      {#each thread.messages as m (m.id)}
        {@const info = deliveryInfo(m)}
        <div class="rounded-md px-2.5 py-1.5 {m.author === 'agent' ? 'bg-zinc-800/60' : 'bg-zinc-900'}">
          <div class="text-[10px] font-medium uppercase tracking-wide text-zinc-500">
            {m.author === 'agent' ? 'Agent' : 'You'}
          </div>
          {#if m.author === 'agent'}
            <div class={PROSE}>{@html renderMarkdown(m.body)}</div>
            {#if implicit.has(m.id)}
              <div class="mt-0.5 text-[10px] italic text-zinc-500">from the agent's final message</div>
            {/if}
          {:else}
            <p class="whitespace-pre-wrap break-words text-[13px] text-zinc-200">{m.body}</p>
          {/if}
          {#if info}
            <div class="mt-1 text-[11px] {TONE[info.tone]}">{info.label}</div>
            {#if info.action === 'retry'}
              <div class="mt-1.5 flex flex-wrap gap-2">
                <button type="button" class={ACTION} onclick={() => retry(m.id)}>Retry</button>
              </div>
            {:else if info.action === 'force-send'}
              <div class="mt-1.5 flex flex-wrap gap-2">
                <button type="button" class={ACTION} onclick={() => copy(m)}>
                  {copiedId === m.id ? 'Copied' : 'Copy'}
                </button>
                <button type="button" class={ACTION} onclick={forceSend}>My prompt is empty, send</button>
              </div>
            {/if}
          {/if}
        </div>
      {/each}

      <textarea
        bind:value={draft}
        class="w-full resize-none rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-2 text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-blue-500"
        rows="2"
        placeholder={thread.status === 'resolved' ? 'Reply to reopen…' : 'Reply…'}
        aria-label="Reply to thread"
      ></textarea>
      {#if error}
        <p role="alert" class="text-xs text-red-300">{error}</p>
      {/if}
      <div class="flex gap-2">
        <button
          type="button"
          class="min-h-10 flex-1 rounded-md bg-orange-600 text-sm font-medium text-white active:bg-orange-500 disabled:opacity-40"
          disabled={!draft.trim() || sending}
          onclick={submit}
        >Send</button>
        {#if thread.status === 'open'}
          <button
            type="button"
            class="min-h-10 flex-1 rounded-md border border-zinc-700 text-sm text-zinc-300 active:bg-zinc-800"
            onclick={() => run(() => agentThreadsStore.setStatus(thread.id, 'resolved'))}
          >Resolve</button>
        {:else}
          <button
            type="button"
            class="min-h-10 flex-1 rounded-md border border-zinc-700 text-sm text-zinc-300 active:bg-zinc-800"
            onclick={() => run(() => agentThreadsStore.setStatus(thread.id, 'open'))}
          >Reopen</button>
        {/if}
      </div>
    </div>
  {/if}
</li>
