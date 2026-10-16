<script lang="ts" module>
  /**
   * Untouched findings show as one line until opened. Module-level so the
   * outline can open one before scrolling to it, and a remount (a layer
   * reloading its diff) keeps it open.
   */
  const expanded = $state<Record<string, true>>({})

  export function expandThread(threadId: string): void {
    expanded[threadId] = true
  }

  /** Tests only. */
  export function _resetExpandedThreads(): void {
    for (const id of Object.keys(expanded)) delete expanded[id]
  }
</script>

<script lang="ts">
  import { tick } from 'svelte'
  import type { ReviewCloseReason, ReviewSeverity, ReviewThread } from '../../../shared/review-room'
  import type { ReviewLayerInfo } from '../../../shared/review-room-ipc'
  import type { PrReviewComment, PrReviewCommentSource } from '../../../shared/screenprs'
  import { truncateSnippet } from '../../../shared/review-drafts'
  import { screenPrsStore } from '../../stores/screenprs.svelte'
  import { reviewRoom } from '../../stores/reviewRoom.svelte'
  import { agentThreadsStore } from '../../stores/agentThreads.svelte'
  import { renderMarkdown } from '../../lib/markdown'
  import { deliveryInfo, type DeliveryInfo } from '../../lib/thread-labels'
  import { anchorLabel, hasUnreadMessages, isPreExisting, messageAuthor, originBadge, splitMessages, threadTitle } from '../../lib/review-room'

  interface Props {
    reviewId: string
    thread: ReviewThread
    /** The thread's draft, found in the draft mirror by `threadId`. */
    draft?: { url: string; comment: PrReviewComment }
    /** Where a new draft goes: the anchor's layer, or the top layer for a whole-stack thread. */
    draftUrl: string
    /** Bottom → top: the layers a whole-stack thread's draft can be posted on. */
    layers: ReviewLayerInfo[]
    companionSessionId?: string
    /** The review was submitted or discarded: shown, never changed. */
    readonly?: boolean
  }

  let { reviewId, thread, draft, draftUrl, layers, companionSessionId, readonly = false }: Props = $props()

  const CLOSE_REASONS: { key: ReviewCloseReason; label: string }[] = [
    { key: 'fixed', label: 'Fixed' },
    { key: 'not-a-problem', label: 'Not a problem' },
    { key: 'intentional', label: 'Intentional' },
    { key: 'wont-fix', label: 'Won’t fix' },
  ]
  const REASON_LABEL: Record<ReviewCloseReason, string> = {
    fixed: 'fixed',
    'not-a-problem': 'not a problem',
    intentional: 'intentional',
    'wont-fix': 'won’t fix',
  }
  const SEVERITIES: ReviewSeverity[] = ['blocking', 'consider', 'nit']
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
    'prose prose-invert prose-sm max-w-none text-[12px] leading-relaxed text-zinc-300 prose-p:my-1 prose-ul:my-1 prose-li:my-0.5 prose-pre:my-1 prose-code:text-[11px]'

  let badge = $derived(originBadge(thread))
  let parts = $derived(splitMessages(thread))
  let title = $derived(threadTitle(thread))
  let proposedSeverity = $derived(thread.origin.kind === 'finding' ? thread.origin.severity : undefined)
  let preExisting = $derived(isPreExisting(thread))
  let isReply = $derived(thread.origin.kind === 'github')
  let collapsed = $derived(
    thread.origin.kind === 'finding' && thread.status === 'open' && !draft && parts.conversation.length === 0 && !thread.proposal && !expanded[thread.id],
  )
  let hasCompanionAnswer = $derived(parts.conversation.some((m) => m.author === 'companion'))

  let statusLabel = $derived(
    thread.status === 'done'
      ? `done${thread.closeReason ? ` · ${REASON_LABEL[thread.closeReason]}` : ''} · ${draft ? 'your comment will be posted' : 'nothing will be posted'}`
      : draft
        ? 'open · comment drafted'
        : 'open',
  )

  // ── Read state: only while on screen in a focused, visible window ──
  let root: HTMLDivElement | undefined = $state()
  let intersecting = $state(false)
  let windowActive = $state(isWindowActive())

  function isWindowActive(): boolean {
    return document.visibilityState === 'visible' && document.hasFocus()
  }

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
      windowActive = isWindowActive()
    }
    window.addEventListener('focus', update)
    window.addEventListener('blur', update)
    document.addEventListener('visibilitychange', update)
    return () => {
      window.removeEventListener('focus', update)
      window.removeEventListener('blur', update)
      document.removeEventListener('visibilitychange', update)
    }
  })

  $effect(() => {
    if (intersecting && windowActive && hasUnreadMessages(thread)) reviewRoom.markRead(thread.id)
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

  async function ask(body: string): Promise<void> {
    const text = body.trim()
    if (!text || sending) return
    sending = true
    if (await run(() => reviewRoom.ask(reviewId, thread.id, text))) {
      if (text === askText.trim()) reviewRoom.setAskDraft(thread.id, '')
    }
    sending = false
  }

  function onAskKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      void ask(askText)
    }
  }

  let chips = $derived.by(() => {
    const out: { label: string; body: string }[] = []
    const o = thread.origin
    if (o.kind === 'github' || (o.kind === 'finding' && o.source === 'author')) {
      out.push({ label: 'Fact-check this', body: 'Fact-check this against the code: does it hold?' })
    }
    if (o.kind === 'finding' && o.source !== 'author') {
      out.push({ label: 'Is this real?', body: 'Is this a real problem?' })
      out.push({ label: 'Right severity?', body: o.severity ? `Is ${o.severity} the right severity?` : 'What severity is this, if any?' })
    }
    if (thread.anchor.kind === 'line') out.push({ label: 'What depends on this?', body: 'What depends on this code, and what breaks if it is wrong?' })
    else out.push({ label: 'What is riskiest here?', body: 'What is the riskiest change here, and why?' })
    const asked = new Set(parts.conversation.filter((m) => m.author === 'user').map((m) => m.body))
    return out.filter((c) => !asked.has(c.body))
  })

  async function retry(messageId: string): Promise<void> {
    const sessionId = companionSessionId
    if (!sessionId) return
    await run(async () => {
      if (!(await agentThreadsStore.retry(sessionId, messageId))) throw new Error("It couldn't be queued again.")
    })
  }

  async function forceSend(): Promise<void> {
    const sessionId = companionSessionId
    if (sessionId) await run(() => agentThreadsStore.forceSend(sessionId))
  }

  async function done(reason?: ReviewCloseReason): Promise<void> {
    confirmingDone = false
    await run(() => reviewRoom.setStatus(reviewId, thread.id, 'done', reason))
  }

  // ── The draft (the only thing ever posted) ──
  let field = $state<HTMLTextAreaElement>()
  let text = $state('')
  let editing = $state(false)
  let saveTimer: ReturnType<typeof setTimeout> | undefined

  // Follows the mirror (another window, the phone, an accepted proposal)
  // except while it is being typed in.
  $effect(() => {
    const saved = draft?.comment.text ?? ''
    if (!editing) text = saved
  })

  function sourceOf(): PrReviewCommentSource {
    const o = thread.origin
    if (o.kind === 'finding' && o.source !== 'author') return o.source
    return 'you'
  }

  function newDraft(body: string, severity?: ReviewSeverity): Omit<PrReviewComment, 'id'> {
    const a = thread.anchor
    const o = thread.origin
    return {
      source: sourceOf(),
      file: a.kind === 'line' ? a.path : '',
      text: body,
      threadId: thread.id,
      ...(a.kind === 'line'
        ? {
            line: a.startLine === a.endLine ? String(a.startLine) : `${a.startLine}-${a.endLine}`,
            side: a.side,
            snippet: truncateSnippet(a.snippet),
            sha: a.headSha,
          }
        : {}),
      ...(o.kind === 'github' ? { inReplyTo: { threadNodeId: o.threadNodeId, rootCommentId: o.rootCommentId } } : {}),
      ...(severity && o.kind !== 'github' ? { severity } : {}),
    }
  }

  async function startDraft(): Promise<void> {
    const item = parts.item[0]?.body ?? ''
    const seed = thread.origin.kind === 'finding' ? item : ''
    screenPrsStore.addComment(draftUrl, newDraft(seed, proposedSeverity))
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

  // Leaving (a layer reloading, the room closing) must not drop what the debounce still holds.
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

  function removeDraft(): void {
    if (draft) screenPrsStore.removeComment(draft.url, draft.comment.id)
  }

  async function acceptProposal(): Promise<void> {
    const p = thread.proposal
    if (!p) return
    if (draft) screenPrsStore.updateComment(draft.url, draft.comment.id, { text: p.text, ...(p.severity && !isReply ? { severity: p.severity } : {}) })
    else screenPrsStore.addComment(draftUrl, newDraft(p.text, p.severity))
    editing = false
    text = p.text
    await run(() => reviewRoom.clearProposal(reviewId, thread.id))
  }

  function redraft(): void {
    void ask('Redraft my comment from our conversation: call propose_draft for this thread with the text (and severity) you would post. Don’t change anything else.')
  }

  let draftWhere = $derived.by(() => {
    if (thread.origin.kind === 'github') return `Reply on GitHub to @${thread.origin.author}`
    const a = thread.anchor
    if (a.kind === 'line') return `Your comment on #${a.pr} · ${a.path.split('/').pop()}:${a.endLine}`
    if (a.kind === 'pr') return `Your comment on #${a.pr}`
    return 'Your comment on'
  })
</script>

{#snippet head(compact: boolean)}
  <div class="flex flex-wrap items-center gap-x-2 gap-y-1 px-2.5 {compact ? 'py-1.5' : 'py-2'}">
    <span class="flex h-5 min-w-5 flex-none items-center justify-center rounded px-1 text-[10px] font-bold {badge.tone}" title={badge.label} data-testid="origin-badge">{badge.mark}</span>
    <span class="text-[10.5px] text-zinc-500">{badge.label}{thread.origin.kind === 'finding' && thread.origin.lens ? ` · ${thread.origin.lens}` : ''}</span>
    <!-- Open, the item itself is the text below; one line stands in for it only when folded. -->
    {#if compact}
      <span class="min-w-[10rem] flex-1 truncate text-[12.5px] font-medium text-zinc-100">{title}</span>
    {:else}
      <span class="flex-1"></span>
    {/if}
    {#if proposedSeverity && thread.status === 'open'}
      <span class="rounded-full px-2 py-px text-[10.5px] font-semibold {SEVERITY_CLASS[proposedSeverity]}" title="The severity {badge.label.toLowerCase()} proposes; yours is set on your comment">
        {badge.label} suggests: {proposedSeverity}
      </span>
    {/if}
    {#if thread.outdated}
      <span class="rounded-full bg-amber-500/15 px-2 py-px text-[10.5px] font-semibold text-amber-300" title="The code at this line changed since the thread was started" data-testid="outdated-badge">outdated</span>
    {/if}
    {#if preExisting}
      <span class="rounded-full bg-zinc-800 px-2 py-px text-[10.5px] text-zinc-400" title="On lines this PR didn't change" data-testid="pre-existing-badge">pre-existing</span>
    {/if}
    {#if thread.origin.kind === 'github' && thread.origin.isResolved}
      <span class="rounded-full bg-zinc-800 px-2 py-px text-[10.5px] text-zinc-400">resolved on GitHub</span>
    {/if}
    <span class="text-[10.5px] text-zinc-500" data-testid="thread-status">{statusLabel}</span>
  </div>
{/snippet}

{#snippet draftBox(locked: boolean)}
  {#if draft}
    <div class="mx-2.5 mb-2.5 flex flex-col gap-1.5 rounded-md border border-blue-500/60 bg-blue-500/[0.08] px-2.5 py-2" data-testid="draft-box">
      <div class="flex flex-wrap items-center gap-2">
        <span class="text-[11.5px] font-semibold text-blue-300">{draftWhere}</span>
        {#if thread.anchor.kind === 'stack' && !locked}
          <select
            class="rounded border border-zinc-700 bg-zinc-900 px-1 py-px text-[11px] text-zinc-200"
            aria-label="Which PR this comment is posted on"
            value={draft.url}
            onchange={(e) => void run(() => reviewRoom.moveDraft(thread.id, e.currentTarget.value))}
          >
            {#each layers as l, i (l.url)}<option value={l.url}>#{l.number}{i === layers.length - 1 ? ' (top)' : ''}</option>{/each}
          </select>
        {:else if thread.anchor.kind === 'stack'}
          <span class="text-[11.5px] font-semibold text-blue-300">#{layers.find((l) => l.url === draft.url)?.number ?? '?'}</span>
        {/if}
        {#if !isReply && !locked}
          <select
            class="rounded border border-zinc-700 bg-zinc-900 px-1 py-px text-[11px] text-zinc-200"
            aria-label="Severity you post"
            value={draft.comment.severity ?? ''}
            onchange={(e) => setSeverity(e.currentTarget.value)}
          >
            {#each SEVERITIES as s (s)}<option value={s}>{s}</option>{/each}
            <option value="">no label</option>
          </select>
        {:else if draft.comment.severity}
          <span class="rounded-full px-2 py-px text-[10.5px] font-semibold {SEVERITY_CLASS[draft.comment.severity]}">{draft.comment.severity}</span>
        {/if}
        <span class="flex-1"></span>
        {#if !locked}
          <button type="button" class="rounded px-1.5 text-[11px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200" onclick={removeDraft}>Remove</button>
        {/if}
      </div>
      {#if locked}
        <p class="whitespace-pre-wrap text-[12px] text-zinc-200">{draft.comment.text}</p>
      {:else}
        <textarea
          bind:this={field}
          class="w-full resize-y rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-[12px] text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-blue-500"
          rows="3"
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
      {/if}
      {#if !locked && !thread.proposal && hasCompanionAnswer}
        <div class="flex flex-wrap items-center gap-2">
          <button type="button" class="rounded bg-violet-500/15 px-2 py-0.5 text-[11px] font-semibold text-violet-300 hover:bg-violet-500/25" onclick={redraft}>Redraft from conversation</button>
          <span class="text-[10.5px] text-zinc-500">Your text stays until you choose.</span>
        </div>
      {/if}
    </div>
  {/if}
{/snippet}

<div
  bind:this={root}
  id="thread-{thread.id}"
  data-thread-card={thread.id}
  class="max-w-[760px] scroll-mt-24 rounded-md border bg-zinc-900 font-sans
    {thread.origin.kind === 'finding' ? 'border-dashed' : ''}
    {thread.status === 'done' || preExisting ? 'opacity-70' : ''}
    {thread.status === 'done' ? 'border-zinc-800' : 'border-zinc-700'}"
>
  {#if collapsed}
    <button type="button" class="w-full text-left hover:bg-zinc-800/50" onclick={() => expandThread(thread.id)} aria-label="Open thread: {title}" data-testid="thread-collapsed">
      {@render head(true)}
    </button>
  {:else if thread.status === 'done'}
    <div class="flex items-center gap-1 pr-2">
      <div class="min-w-0 flex-1">{@render head(true)}</div>
      {#if !readonly}
        <button type="button" class="flex-none rounded px-2 py-0.5 text-[11px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200" onclick={() => void run(() => reviewRoom.setStatus(reviewId, thread.id, 'open'))}>Reopen</button>
      {/if}
    </div>
    {@render draftBox(true)}
  {:else}
    {@render head(false)}
    <div class="flex flex-col gap-2 px-2.5 pb-2">
      {#if thread.anchor.kind === 'line'}
        <div class="font-mono text-[10.5px] text-zinc-500">{anchorLabel(thread.anchor)}</div>
        {#if thread.outdated && thread.anchor.snippet}
          <pre class="max-h-24 overflow-auto rounded border border-zinc-800 bg-zinc-950 px-2 py-1 font-mono text-[10.5px] text-zinc-400">{thread.anchor.snippet}</pre>
        {/if}
      {/if}
      {#each parts.item as m, i (m.id)}
        <div>
          <div class="text-[10px] font-medium uppercase tracking-wide text-zinc-500">{messageAuthor(thread, m, i === 0)}</div>
          <div class={PROSE}>{@html renderMarkdown(m.body)}</div>
        </div>
      {/each}
      {#if parts.conversation.length}
        <div class="ml-1 flex flex-col gap-1.5 border-l-2 border-violet-500/30 pl-2.5" data-testid="conversation">
          <div class="text-[9.5px] font-semibold uppercase tracking-wider text-violet-300/80">Private · you and the companion</div>
          {#each parts.conversation as m (m.id)}
            {@const info = deliveryInfo(m)}
            <div class="rounded px-1.5 py-1 {m.author === 'companion' ? 'bg-zinc-800/60' : ''}" data-testid="message">
              <div class="text-[10px] font-medium uppercase tracking-wide {m.author === 'companion' ? 'text-violet-300/80' : 'text-zinc-500'}">{messageAuthor(thread, m, false)}</div>
              {#if m.author === 'user'}
                <p class="whitespace-pre-wrap break-words text-[12px] text-zinc-200">{m.body}</p>
              {:else}
                <div class={PROSE}>{@html renderMarkdown(m.body)}</div>
              {/if}
              {#if m.readFiles?.length}
                <div class="mt-1 flex flex-wrap gap-1">
                  <span class="text-[10px] text-zinc-500">read</span>
                  {#each m.readFiles as f (f)}<span class="rounded bg-violet-500/10 px-1.5 font-mono text-[10px] text-violet-300">{f}</span>{/each}
                </div>
              {/if}
              {#if info}
                <div class="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] {TONE[info.tone]}" data-testid="delivery">
                  <span>{info.label}</span>
                  {#if info.action === 'retry'}
                    <button
                      type="button"
                      class="rounded border border-zinc-700 px-1.5 text-zinc-300 hover:bg-zinc-700 disabled:opacity-40"
                      disabled={!companionSessionId}
                      title={companionSessionId ? undefined : 'Start the companion first'}
                      onclick={() => retry(m.id)}
                    >Retry</button>
                  {:else if info.action === 'force-send'}
                    <button type="button" class="rounded border border-zinc-700 px-1.5 text-zinc-300 hover:bg-zinc-700" onclick={forceSend}>My prompt is empty, send</button>
                  {/if}
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>

    {#if !readonly}
    <div class="flex flex-col gap-1.5 px-2.5 pb-2">
      {#if chips.length}
        <div class="flex flex-wrap gap-1">
          {#each chips as c (c.label)}
            <button
              type="button"
              class="rounded-full border border-zinc-700 bg-zinc-800 px-2 py-px text-[11px] text-zinc-300 hover:border-violet-500 hover:text-violet-200 disabled:opacity-50"
              disabled={sending}
              onclick={() => void ask(c.body)}
            >{c.label}</button>
          {/each}
        </div>
      {/if}
      <div class="flex items-end gap-1.5">
        <textarea
          class="min-h-8 min-w-0 flex-1 resize-y rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-[12px] text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-violet-500"
          rows="1"
          placeholder="Ask the companion about this…"
          aria-label="Ask the companion"
          value={askText}
          oninput={(e) => reviewRoom.setAskDraft(thread.id, e.currentTarget.value)}
          onkeydown={onAskKeydown}
        ></textarea>
        <button
          type="button"
          class="rounded bg-violet-500/15 px-2.5 py-1 text-[11.5px] font-semibold text-violet-300 hover:bg-violet-500/25 disabled:opacity-40"
          disabled={!askText.trim() || sending}
          onclick={() => void ask(askText)}
        >Ask</button>
      </div>
    </div>
    {/if}

    {#if thread.proposal}
      <div class="mx-2.5 mb-2 flex flex-col gap-1.5 rounded-md border border-dashed border-violet-500/50 bg-violet-500/[0.06] px-2.5 py-2" data-testid="proposal">
        <div class="flex flex-wrap items-center gap-2 text-[11px] text-zinc-400">
          The companion suggests this text, from your conversation:
          {#if thread.proposal.severity && !isReply}
            <span class="rounded-full px-2 py-px text-[10.5px] font-semibold {SEVERITY_CLASS[thread.proposal.severity]}">{thread.proposal.severity}</span>
          {/if}
        </div>
        <p class="whitespace-pre-wrap text-[12px] text-zinc-200">{thread.proposal.text}</p>
        {#if !readonly}
        <div class="flex gap-1.5">
          <button type="button" class="rounded bg-blue-600 px-2 py-0.5 text-[11px] text-white hover:bg-blue-500" onclick={acceptProposal}>Accept</button>
          <button type="button" class="rounded px-2 py-0.5 text-[11px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200" onclick={() => void run(() => reviewRoom.clearProposal(reviewId, thread.id))}>Keep mine</button>
        </div>
        {/if}
      </div>
    {/if}

    {@render draftBox(readonly)}

    {#if !readonly}
    <div class="flex flex-wrap items-center gap-1.5 px-2.5 pb-2.5">
      {#if !draft}
        <button type="button" class="rounded bg-blue-600 px-2.5 py-0.5 text-[11.5px] text-white hover:bg-blue-500" onclick={startDraft}>
          {isReply ? 'Draft reply' : 'Draft comment'}
        </button>
      {/if}
      {#if confirmingDone}
        <span class="text-[11px] text-zinc-500">Done because:</span>
        {#each CLOSE_REASONS as r (r.key)}
          <button type="button" class="rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-800" onclick={() => done(r.key)}>{r.label}</button>
        {/each}
        <button type="button" class="rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-800" onclick={() => done()}>No reason</button>
        <button type="button" class="px-1 text-[11px] text-zinc-500 hover:text-zinc-300" onclick={() => (confirmingDone = false)}>Cancel</button>
      {:else}
        <button type="button" class="rounded border border-zinc-700 px-2.5 py-0.5 text-[11.5px] text-zinc-300 hover:bg-zinc-800" onclick={() => (confirmingDone = true)}>Done</button>
        <span class="text-[10.5px] text-zinc-500">{draft ? 'Done keeps your comment; it posts when you submit.' : 'Nothing is posted unless you draft a comment.'}</span>
      {/if}
    </div>
    {/if}
  {/if}
  {#if error}
    <p role="alert" class="px-2.5 pb-2 text-[11px] text-red-300">{error}</p>
  {/if}
</div>
