<script lang="ts" module>
  /**
   * Untouched findings show as one line until opened. Module-level so the
   * outline can open one before scrolling to it, and a remount keeps it open.
   */
  const expanded = $state<Record<string, true>>({})

  export function expandRoomThread(threadId: string): void {
    expanded[threadId] = true
  }

  /** Tests only. */
  export function _resetRoomThreads(): void {
    for (const id of Object.keys(expanded)) delete expanded[id]
  }
</script>

<script lang="ts">
  /**
   * One Review Room thread on the phone: the desktop's `ReviewThreadCard` laid
   * out for a thumb, on the same helpers (`renderer/lib/review-room.ts`) and
   * stores, so what a thread offers, drafts and posts can't differ between
   * the two. The item, the private conversation (Ask, Ask author, chips), the
   * draft (the only thing ever posted), the companion's proposal, and Done.
   *
   * Asking needs no terminal here: main types the question into the
   * companion, which lives in a desktop window (`askBlocked` says when none
   * can host one). Enter adds a newline; Ask is a button.
   */
  import { tick } from 'svelte'
  import type { ReviewCloseReason, ReviewSeverity, ReviewThread } from '../shared/review-room'
  import type { ReviewLayerInfo } from '../shared/review-room-ipc'
  import { screenPrsStore } from '../renderer/stores/screenprs.svelte'
  import { reviewRoom } from '../renderer/stores/reviewRoom.svelte'
  import { agentThreadsStore } from '../renderer/stores/agentThreads.svelte'
  import { renderMarkdown } from '../renderer/lib/markdown'
  import { deliveryInfo, type DeliveryInfo } from '../renderer/lib/thread-labels'
  import {
    CLOSE_REASONS,
    REDRAFT_PROMPT,
    SEVERITIES,
    anchorLabel,
    draftWhere,
    hasUnreadMessages,
    isFolded,
    isPreExisting,
    messageAuthor,
    originBadge,
    splitMessages,
    threadChips,
    threadDraft,
    threadStatusLabel,
    threadTitle,
    type ThreadDraft,
  } from '../renderer/lib/review-room'
  import { holdUnsaved } from './lib/unsaved-work'

  interface Props {
    reviewId: string
    thread: ReviewThread
    draft?: ThreadDraft
    /** Where a new draft goes: the anchor's layer, or the top layer for a whole-stack thread. */
    draftUrl: string
    /** Bottom → top. */
    layers: ReviewLayerInfo[]
    companionSessionId?: string
    readonly?: boolean
    /** The live session that requested the review: offers Ask author. */
    requesterSessionId?: string
    /** Why a question to the companion can't be sent right now. */
    askBlocked?: string | null
    /** The room is the screen on top: only then does showing a thread read it. */
    visible: boolean
  }

  let { reviewId, thread, draft, draftUrl, layers, companionSessionId, readonly = false, requesterSessionId, askBlocked = null, visible }: Props = $props()

  const SEVERITY_CLASS: Record<ReviewSeverity, string> = {
    blocking: 'bg-red-500/15 text-red-300',
    consider: 'bg-amber-500/15 text-amber-300',
    nit: 'bg-zinc-700 text-zinc-300',
  }
  const TONE: Record<DeliveryInfo['tone'], string> = {
    muted: 'text-zinc-500',
    waiting: 'text-amber-300/80',
    ok: 'text-emerald-400/80',
    error: 'text-red-300',
  }
  const PROSE =
    'prose prose-invert prose-sm max-w-none text-[13px] leading-relaxed text-zinc-300 prose-p:my-1 prose-ul:my-1 prose-li:my-0.5 prose-pre:my-1 prose-code:text-[12px]'
  const SMALL_BTN = 'min-h-9 rounded-lg border border-zinc-700 px-3 text-[13px] text-zinc-300 active:bg-zinc-800 disabled:opacity-40'

  let badge = $derived(originBadge(thread))
  let parts = $derived(splitMessages(thread))
  let title = $derived(threadTitle(thread))
  let proposedSeverity = $derived(thread.origin.kind === 'finding' ? thread.origin.severity : undefined)
  let preExisting = $derived(isPreExisting(thread))
  let isReply = $derived(thread.origin.kind === 'github')
  let collapsed = $derived(isFolded(thread, !!draft) && !expanded[thread.id])
  let hasCompanionAnswer = $derived(parts.conversation.some((m) => m.author === 'companion'))
  let statusLabel = $derived(threadStatusLabel(thread, !!draft))
  let chips = $derived(threadChips(thread))
  let withAuthor = $derived(parts.conversation.some((m) => m.author === 'author' || m.toAuthor))

  // ── Read state: only while on screen, on the screen on top, in a visible page ──
  let root: HTMLDivElement | undefined = $state()
  let intersecting = $state(false)
  let pageVisible = $state(document.visibilityState === 'visible')

  $effect(() => {
    if (!root) return
    const io = new IntersectionObserver((entries) => {
      intersecting = entries.some((e) => e.isIntersecting)
    })
    io.observe(root)
    return () => io.disconnect()
  })
  $effect(() => {
    const update = (): void => {
      pageVisible = document.visibilityState === 'visible'
    }
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  })
  $effect(() => {
    if (visible && intersecting && pageVisible && !collapsed && hasUnreadMessages(thread)) reviewRoom.markRead(thread.id)
  })

  // ── Actions ──
  let error = $state<string | null>(null)
  let sending = $state(false)
  let confirmingDone = $state(false)

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

  let askText = $derived(reviewRoom.askDraft(thread.id))
  $effect(() => holdUnsaved(() => (askText.trim() ? 'your unsent question in a review thread' : null)))

  async function send(body: string, to: 'companion' | 'author'): Promise<void> {
    const text = body.trim()
    if (!text || sending) return
    sending = true
    const sent = await run(() => (to === 'author' ? reviewRoom.askAuthor(reviewId, thread.id, text) : reviewRoom.ask(reviewId, thread.id, text)))
    if (sent && text === askText.trim()) reviewRoom.setAskDraft(thread.id, '')
    sending = false
  }

  /** A question to the author goes to the requester; everything else to the companion. */
  const recipientOf = (m: { toAuthor?: boolean }): string | undefined => (m.toAuthor ? requesterSessionId : companionSessionId)

  async function retry(messageId: string, sessionId: string | undefined): Promise<void> {
    if (!sessionId) return
    await run(async () => {
      if (!(await agentThreadsStore.retry(sessionId, messageId))) throw new Error("It couldn't be queued again.")
    })
  }

  async function forceSend(sessionId: string | undefined): Promise<void> {
    if (sessionId) await run(() => agentThreadsStore.forceSend(sessionId))
  }

  async function done(reason?: ReviewCloseReason): Promise<void> {
    confirmingDone = false
    await run(() => reviewRoom.setStatus(reviewId, thread.id, 'done', reason))
  }

  // ── The draft ──
  let field = $state<HTMLTextAreaElement>()
  let text = $state('')
  let editing = $state(false)
  let saveTimer: ReturnType<typeof setTimeout> | undefined

  // Follows the mirror (the desk, an accepted proposal) except while it is being typed in.
  $effect(() => {
    const saved = draft?.comment.text ?? ''
    if (!editing) text = saved
  })

  async function startDraft(): Promise<void> {
    const seed = thread.origin.kind === 'finding' ? (parts.item[0]?.body ?? '') : ''
    screenPrsStore.addComment(draftUrl, threadDraft(thread, seed, proposedSeverity))
    await tick()
    field?.focus()
  }

  function save(): void {
    clearTimeout(saveTimer)
    saveTimer = undefined
    if (draft && text !== draft.comment.text) screenPrsStore.updateComment(draft.url, draft.comment.id, { text })
  }

  function onDraftInput(value: string): void {
    text = value
    clearTimeout(saveTimer)
    saveTimer = setTimeout(save, 500)
  }

  $effect(() => () => {
    if (saveTimer !== undefined) save()
  })

  function setSeverity(value: string): void {
    if (!draft) return
    const c = draft.comment
    if (value === 'blocking' || value === 'consider' || value === 'nit') {
      screenPrsStore.updateComment(draft.url, c.id, { severity: value })
    } else if (c.severity) {
      // A patch can't clear a field (absent means "unchanged"), so the comment
      // is replaced by one without it.
      const { id: _id, severity: _severity, ...rest } = c
      screenPrsStore.removeComment(draft.url, c.id)
      screenPrsStore.addComment(draft.url, { ...rest, text })
    }
  }

  async function acceptProposal(): Promise<void> {
    const p = thread.proposal
    if (!p) return
    if (draft) screenPrsStore.updateComment(draft.url, draft.comment.id, { text: p.text, ...(p.severity && !isReply ? { severity: p.severity } : {}) })
    else screenPrsStore.addComment(draftUrl, threadDraft(thread, p.text, p.severity))
    editing = false
    text = p.text
    await run(() => reviewRoom.clearProposal(reviewId, thread.id))
  }
</script>

{#snippet head(compact: boolean)}
  <div class="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 {compact ? 'py-2.5' : 'pt-3 pb-1.5'}">
    <span class="flex h-5 min-w-5 flex-none items-center justify-center rounded px-1 text-[10px] font-bold {badge.tone}" title={badge.label} data-testid="origin-badge">{badge.mark}</span>
    <span class="text-[11px] text-zinc-500">{badge.label}{thread.origin.kind === 'finding' && thread.origin.lens ? ` · ${thread.origin.lens}` : ''}</span>
    {#if compact}<span class="w-full truncate text-[13.5px] font-medium text-zinc-100">{title}</span>{/if}
    {#if proposedSeverity && thread.status === 'open'}
      <span class="rounded-full px-2 py-px text-[11px] font-semibold {SEVERITY_CLASS[proposedSeverity]}">suggests: {proposedSeverity}</span>
    {/if}
    {#if thread.outdated}<span class="rounded-full bg-amber-500/15 px-2 py-px text-[11px] font-semibold text-amber-300" data-testid="outdated-badge">outdated</span>{/if}
    {#if preExisting}<span class="rounded-full bg-zinc-800 px-2 py-px text-[11px] text-zinc-400" data-testid="pre-existing-badge">pre-existing</span>{/if}
    {#if thread.origin.kind === 'github' && thread.origin.isResolved}<span class="rounded-full bg-zinc-800 px-2 py-px text-[11px] text-zinc-400">resolved on GitHub</span>{/if}
    <span class="text-[11px] text-zinc-500" data-testid="thread-status">{statusLabel}</span>
  </div>
{/snippet}

{#snippet draftBox(locked: boolean)}
  {#if draft}
    <div class="mx-3 mb-3 flex flex-col gap-2 rounded-lg border border-blue-500/60 bg-blue-500/[0.08] px-2.5 py-2" data-testid="draft-box">
      <div class="flex flex-wrap items-center gap-2">
        <span class="text-[12px] font-semibold text-blue-300">{draftWhere(thread)}</span>
        {#if thread.anchor.kind === 'stack' && !locked}
          <select
            class="min-h-9 rounded border border-zinc-700 bg-zinc-900 px-1 text-zinc-200"
            aria-label="Which PR this comment is posted on"
            value={draft.url}
            onchange={(e) => void run(() => reviewRoom.moveDraft(thread.id, e.currentTarget.value))}
          >
            {#each layers as l, i (l.url)}<option value={l.url}>#{l.number}{i === layers.length - 1 ? ' (top)' : ''}</option>{/each}
          </select>
        {:else if thread.anchor.kind === 'stack'}
          <span class="text-[12px] font-semibold text-blue-300">#{layers.find((l) => l.url === draft.url)?.number ?? '?'}</span>
        {/if}
      </div>
      {#if locked}
        <p class="whitespace-pre-wrap text-[13px] text-zinc-200">{draft.comment.text}</p>
        {#if draft.comment.severity}<span class="self-start rounded-full px-2 py-px text-[11px] font-semibold {SEVERITY_CLASS[draft.comment.severity]}">{draft.comment.severity}</span>{/if}
      {:else}
        <textarea
          bind:this={field}
          class="min-h-20 w-full resize-y rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-blue-500"
          placeholder="Write what you want to post"
          aria-label="Your comment"
          value={text}
          onfocus={() => (editing = true)}
          oninput={(e) => onDraftInput(e.currentTarget.value)}
          onblur={() => {
            editing = false
            save()
          }}
        ></textarea>
        <div class="flex flex-wrap items-center gap-2">
          {#if !isReply}
            <select
              class="min-h-9 rounded border border-zinc-700 bg-zinc-900 px-1 text-zinc-200"
              aria-label="Severity you post"
              value={draft.comment.severity ?? ''}
              onchange={(e) => setSeverity(e.currentTarget.value)}
            >
              {#each SEVERITIES as s (s)}<option value={s}>{s}</option>{/each}
              <option value="">no label</option>
            </select>
          {/if}
          <span class="flex-1"></span>
          <button type="button" class={SMALL_BTN} onclick={() => draft && screenPrsStore.removeComment(draft.url, draft.comment.id)}>Remove</button>
        </div>
        {#if !thread.proposal && hasCompanionAnswer}
          <button type="button" class="min-h-9 self-start rounded-lg bg-violet-500/15 px-3 text-[13px] font-semibold text-violet-300 disabled:opacity-40" disabled={!!askBlocked || sending} onclick={() => void send(REDRAFT_PROMPT, 'companion')}>
            Redraft from conversation
          </button>
        {/if}
      {/if}
    </div>
  {/if}
{/snippet}

<div
  bind:this={root}
  id="room-thread-{thread.id}"
  data-testid="room-thread"
  data-thread-card={thread.id}
  class="rounded-lg border bg-zinc-900 font-sans
    {thread.origin.kind === 'finding' ? 'border-dashed' : ''}
    {thread.status === 'done' || preExisting ? 'opacity-75' : ''}
    {thread.status === 'done' ? 'border-zinc-800' : 'border-zinc-700'}"
>
  {#if collapsed}
    <button type="button" class="w-full text-left active:bg-zinc-800/60" onclick={() => expandRoomThread(thread.id)} aria-label="Open thread: {title}" data-testid="thread-collapsed">
      {@render head(true)}
    </button>
  {:else if thread.status === 'done'}
    {@render head(true)}
    {#if !readonly}
      <div class="px-3 pb-2"><button type="button" class={SMALL_BTN} onclick={() => void run(() => reviewRoom.setStatus(reviewId, thread.id, 'open'))}>Reopen</button></div>
    {/if}
    {@render draftBox(true)}
  {:else}
    {@render head(false)}
    <div class="flex flex-col gap-2 px-3 pb-2">
      {#if thread.anchor.kind === 'line'}
        <div class="break-all font-mono text-[11px] text-zinc-500">{anchorLabel(thread.anchor)}</div>
        {#if thread.outdated && thread.anchor.snippet}
          <pre class="max-h-24 overflow-auto rounded border border-zinc-800 bg-zinc-950 px-2 py-1 font-mono text-[11px] text-zinc-400">{thread.anchor.snippet}</pre>
        {/if}
      {/if}
      {#each parts.item as m, i (m.id)}
        <div>
          <div class="text-[10.5px] font-medium uppercase tracking-wide text-zinc-500">{messageAuthor(thread, m, i === 0)}</div>
          <div class={PROSE}>{@html renderMarkdown(m.body)}</div>
        </div>
      {/each}
      {#if parts.conversation.length}
        <div class="flex flex-col gap-1.5 border-l-2 border-violet-500/30 pl-2.5" data-testid="conversation">
          <div class="text-[10px] font-semibold uppercase tracking-wider text-violet-300/80">{withAuthor ? 'You, the companion and the PR author' : 'Private · you and the companion'}</div>
          {#each parts.conversation as m (m.id)}
            {@const info = deliveryInfo(m)}
            {@const to = recipientOf(m)}
            <div class="rounded px-1.5 py-1 {m.author === 'companion' || m.author === 'author' ? 'bg-zinc-800/60' : ''}" data-testid="message">
              <div class="text-[10.5px] font-medium uppercase tracking-wide {m.author === 'companion' ? 'text-violet-300/80' : m.author === 'author' ? 'text-sky-300/80' : 'text-zinc-500'}">{messageAuthor(thread, m, false)}</div>
              {#if m.author === 'user'}
                <p class="whitespace-pre-wrap break-words text-[13px] text-zinc-200">{m.body}</p>
              {:else}
                <div class={PROSE}>{@html renderMarkdown(m.body)}</div>
              {/if}
              {#if m.readFiles?.length}
                <div class="mt-1 flex flex-wrap gap-1">
                  <span class="text-[10.5px] text-zinc-500">read</span>
                  {#each m.readFiles as f (f)}<span class="break-all rounded bg-violet-500/10 px-1.5 font-mono text-[10.5px] text-violet-300">{f}</span>{/each}
                </div>
              {/if}
              {#if info}
                <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] {TONE[info.tone]}" data-testid="delivery">
                  <span>{info.label}</span>
                  {#if info.action === 'retry'}
                    <button type="button" class={SMALL_BTN} disabled={!to} onclick={() => retry(m.id, to)}>Retry</button>
                    {#if !to}<span class="text-zinc-500">{m.toAuthor ? 'The requesting session has ended.' : 'No companion is running.'}</span>{/if}
                  {:else if info.action === 'force-send'}
                    <button type="button" class={SMALL_BTN} onclick={() => forceSend(to)}>Its prompt is empty, send</button>
                  {/if}
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>

    {#if !readonly}
      <div class="flex flex-col gap-2 px-3 pb-2">
        {#if chips.length}
          <div class="flex flex-wrap gap-1.5">
            {#each chips as c (c.label)}
              <button
                type="button"
                class="min-h-9 rounded-full border border-zinc-700 bg-zinc-800 px-3 text-[12.5px] text-zinc-300 active:border-violet-500 disabled:opacity-40"
                disabled={sending || !!askBlocked}
                onclick={() => void send(c.body, 'companion')}
              >{c.label}</button>
            {/each}
          </div>
        {/if}
        <textarea
          class="min-h-11 w-full resize-y rounded border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-violet-500"
          rows="2"
          placeholder="Ask the companion about this…"
          aria-label="Ask the companion"
          value={askText}
          oninput={(e) => reviewRoom.setAskDraft(thread.id, e.currentTarget.value)}
        ></textarea>
        <div class="flex flex-wrap items-center justify-end gap-2">
          {#if requesterSessionId}
            <button
              type="button"
              class="min-h-10 rounded-lg bg-sky-500/15 px-3 text-sm font-semibold text-sky-300 disabled:opacity-40"
              disabled={!askText.trim() || sending}
              data-testid="ask-author"
              onclick={() => void send(askText, 'author')}
            >Ask author</button>
          {/if}
          <button
            type="button"
            class="min-h-10 rounded-lg bg-violet-500/20 px-4 text-sm font-semibold text-violet-200 disabled:opacity-40"
            disabled={!askText.trim() || sending || !!askBlocked}
            data-testid="ask"
            onclick={() => void send(askText, 'companion')}
          >Ask</button>
        </div>
        {#if askBlocked}<p class="text-[11px] text-amber-300/90" data-testid="ask-blocked">{askBlocked}</p>{/if}
        {#if thread.askAuthorOpen}<p class="text-[11px] text-sky-300/80">Waiting for the PR author’s answer.</p>{/if}
      </div>
    {/if}

    {#if thread.proposal}
      <div class="mx-3 mb-2 flex flex-col gap-1.5 rounded-lg border border-dashed border-violet-500/50 bg-violet-500/[0.06] px-2.5 py-2" data-testid="proposal">
        <div class="flex flex-wrap items-center gap-2 text-[12px] text-zinc-400">
          The companion suggests this text, from your conversation:
          {#if thread.proposal.severity && !isReply}
            <span class="rounded-full px-2 py-px text-[11px] font-semibold {SEVERITY_CLASS[thread.proposal.severity]}">{thread.proposal.severity}</span>
          {/if}
        </div>
        <p class="whitespace-pre-wrap text-[13px] text-zinc-200">{thread.proposal.text}</p>
        {#if !readonly}
          <div class="flex gap-2">
            <button type="button" class="min-h-9 rounded-lg bg-blue-600 px-3 text-[13px] text-white" onclick={acceptProposal}>Accept</button>
            <button type="button" class={SMALL_BTN} onclick={() => void run(() => reviewRoom.clearProposal(reviewId, thread.id))}>Keep mine</button>
          </div>
        {/if}
      </div>
    {/if}

    {@render draftBox(readonly)}

    {#if !readonly}
      <div class="flex flex-wrap items-center gap-2 px-3 pb-3">
        {#if !draft}
          <button type="button" class="min-h-9 rounded-lg bg-blue-600 px-3 text-[13px] text-white active:bg-blue-500" data-testid="start-draft" onclick={startDraft}>
            {isReply ? 'Draft reply' : 'Draft comment'}
          </button>
        {/if}
        {#if confirmingDone}
          <span class="w-full text-[12px] text-zinc-500">Done because:</span>
          {#each CLOSE_REASONS as r (r.key)}
            <button type="button" class={SMALL_BTN} onclick={() => done(r.key)}>{r.label}</button>
          {/each}
          <button type="button" class={SMALL_BTN} onclick={() => done()}>No reason</button>
          <button type="button" class="min-h-9 px-2 text-[13px] text-zinc-500" onclick={() => (confirmingDone = false)}>Cancel</button>
        {:else}
          <button type="button" class={SMALL_BTN} data-testid="done" onclick={() => (confirmingDone = true)}>Done</button>
          <span class="text-[11px] text-zinc-500">{draft ? 'Done keeps your comment; it posts when you submit.' : 'Nothing is posted unless you draft a comment.'}</span>
        {/if}
      </div>
    {/if}
  {/if}
  {#if error}
    <p role="alert" class="px-3 pb-2 text-[12px] text-red-300">{error}</p>
  {/if}
</div>
