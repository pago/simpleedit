<script lang="ts">
  /**
   * One pull request, fully reviewable.
   *
   * A detail screen, so: back button (the shell's) and a segmented control,
   * which this screen earns because it genuinely has two panes —
   * **Conversation** (what the PR says and what triage and deep review make of
   * it) and **Files** (the diff, where line comments come from). Both panes
   * stay mounted, each with its own scroll, so flipping between them to check
   * a finding against the code does not lose your place in either.
   *
   * The diff is fetched here rather than pushed with the board: a card reaches
   * a socket client with `diff` emptied, because screening spans every org
   * where you're a reviewer and a board of full diffs is megabytes for the sake
   * of the one PR you open.
   */
  import { screenPrsStore } from '../renderer/stores/screenprs.svelte'
  import { DEEP_LENS_LABEL, DEEP_LENS_ORDER, anchorCounts, anchorsForHead, baseWarning } from '../shared/screenprs'
  import { truncateSnippet } from '../shared/review-drafts'
  import type {
    DeepFinding,
    DeepSeverity,
    PrRef,
    PrReviewComment,
    TriageFinding,
    PrCiStatus,
  } from '../shared/screenprs'
  import { cachedDiff, fetchDiff, type CommentTarget } from './lib/prs.svelte'
  import PrDiff from './PrDiff.svelte'
  import OverviewCard from '../renderer/components/screenprs/OverviewCard.svelte'
  import { resolveRefPath, type OverviewLookIntoItem, type OverviewRef } from '../shared/pr-overview'
  import { parseUnifiedDiff } from '../shared/parseDiff'
  import { tick } from 'svelte'
  import ComposeSheet from './ComposeSheet.svelte'
  import PrReviewSheet from './PrReviewSheet.svelte'
  import { nav } from './lib/nav.svelte'

  interface Props {
    pr: PrRef
    connected: boolean
  }

  let { pr, connected }: Props = $props()

  let url = $derived(pr.url)
  // Read straight out of the queue rather than through the store's `select`:
  // the entry has to be right on the first render, and a selection set from an
  // effect isn't.
  let entry = $derived(screenPrsStore.entries().find((e) => e.ref.url === url))
  let card = $derived(entry?.card)
  let context = $derived(entry?.context)
  let deep = $derived(screenPrsStore.deepFor(url))
  let overview = $derived(screenPrsStore.overviewFor(url))
  let warning = $derived(context ? baseWarning(context) : null)

  const PANES = [
    { id: 'conversation', label: 'Conversation' },
    { id: 'files', label: 'Files' },
  ] as const
  let pane = $state<(typeof PANES)[number]['id']>('conversation')

  // ── the diff ──
  // Keyed by head SHA, so a PR whose head moved between screenings refetches
  // instead of showing yesterday's code under today's line numbers. Nothing is
  // fetched until the SHA is known — a URL alone would cache under the wrong key.
  let headSha = $derived(context?.headSha ?? '')
  /**
   * The draft as it would be posted.
   *
   * A line anchor survives only where it can be shown to belong to the head on
   * screen; a line number read off another commit would land on whatever code
   * sits there now. Resolved once, here, so the diff, the sheet and the
   * confirm's counts cannot disagree. Main runs the same `anchorsForHead` on
   * the raw draft before posting, so it can say which comments it folded.
   */
  let rawDraft = $derived(screenPrsStore.draftFor(url))
  let draft = $derived(anchorsForHead(rawDraft, headSha))
  /**
   * Counted on the RAW draft, because `draft` has already had the failing
   * anchors removed — classifying it would report every one of them as "never
   * had a line" and the reviewer would be told nothing.
   */
  let anchors = $derived(anchorCounts(rawDraft, headSha))
  let isolatedBase = $derived(context?.base?.kind === 'polluted' && context.base.isolated)
  let diff = $state('')
  let diffError = $state<string | null>(null)
  let loadingDiff = $state(false)

  $effect(() => {
    const sha = headSha
    const target = url
    // Read so a reconnect re-runs this. During the backoff there is no socket
    // and `invoke` refuses rather than queueing, so without this a read that
    // failed while the connection was down would have nothing to retry it.
    const online = connected
    diffError = null
    if (!sha) {
      diff = ''
      loadingDiff = false
      return
    }
    const have = cachedDiff(target, sha)
    if (have !== undefined) {
      diff = have
      loadingDiff = false
      return
    }
    diff = ''
    if (!online) {
      loadingDiff = false
      return
    }
    loadingDiff = true
    // The fetch belongs to this PR at this SHA. Switching PRs mid-flight must
    // not let the old diff land on the new screen.
    let live = true
    void fetchDiff(target, sha)
      .then((next) => { if (live) diff = next })
      .catch((err: unknown) => { if (live) diffError = err instanceof Error ? err.message : String(err) })
      .finally(() => { if (live) loadingDiff = false })
    return () => { live = false }
  })

  // ── line comments ──
  // The sheet is a layer on the navigation stack, so Back dismisses it — after
  // asking, when there is text in it. A new comment and an edit share it.
  let target = $state<CommentTarget | null>(null)
  let editing = $state<PrReviewComment | null>(null)
  let composeId = $state<number | null>(null)
  let composeSheet = $state<ComposeSheet | undefined>()

  function pushCompose(): void {
    composeId = nav.push({ kind: 'compose', url }, () => composeSheet?.holdForDraft() ?? false).id
  }
  function openCompose(next: CommentTarget): void {
    target = next
    editing = null
    pushCompose()
  }
  function openEdit(c: PrReviewComment): void {
    target = null
    editing = c
    pushCompose()
  }

  const where = (file: string, line: string | undefined, side: 'LEFT' | 'RIGHT' | undefined): string =>
    `${file}${line ? `:${line}` : ''}${side === 'LEFT' ? ' · deleted line' : ''}`

  /**
   * A comment is stamped with the head ITS OWN line was computed against, which
   * is not always the head that is live when the button is tapped.
   *
   * A tapped diff row belongs to the diff on screen. A triage finding belongs
   * to the card it was produced from. A deep finding belongs to the commit the
   * lenses ran over — and deep findings outlive their card, because `_deep`
   * survives the `_onQueued` that empties the queue, so their `＋` buttons are
   * live in a window where the live head is not known at all.
   *
   * Reading the live head there would stamp nothing, and an unstamped comment
   * can never be shown to have gone stale — a permanently un-checkable anchor
   * rather than a transiently un-checkable one.
   */
  function addLineComment(text: string): void {
    const t = target
    if (!t) return
    screenPrsStore.addComment(url, {
      source: 'you',
      file: t.file,
      line: t.line,
      side: t.side,
      snippet: truncateSnippet(t.snippet),
      text,
      sha: headSha || undefined,
    })
  }

  function addTriage(f: TriageFinding): void {
    screenPrsStore.addComment(url, {
      source: 'triage',
      file: f.file,
      line: f.line,
      text: f.title,
      sha: card?.headSha,
    })
  }
  function addDeep(f: DeepFinding): void {
    screenPrsStore.addComment(url, {
      source: 'deep',
      file: f.file,
      line: f.line,
      text: f.detail ? `${f.title} — ${f.detail}` : f.title,
      sha: deep?.headSha,
    })
  }

  /**
   * Fire-and-forget: the lenses take minutes and their findings arrive on the
   * `screenprs:deep-*` stream whether or not this screen is still open. The
   * context has to carry the diff the board didn't send.
   */
  function runDeep(): void {
    if (!context || !diff) return
    void screenPrsStore.startDeep({ ...context, diff })
  }

  /** Same re-attach as `runDeep`: the board's context arrived without its diff. */
  function runOverview(): void {
    if (!context || !diff) return
    void screenPrsStore.startOverview({ ...context, diff })
  }

  let prDiff = $state<PrDiff | undefined>()
  /** A citation lives in the Files pane: switch there first, then scroll once it is showing. */
  async function showRef(ref: OverviewRef): Promise<void> {
    pane = 'files'
    await tick()
    await prDiff?.reveal(ref.path, ref.line)
  }
  function addOverview(item: OverviewLookIntoItem): void {
    const ref = item.refs[0]
    const paths = parseUnifiedDiff(diff).map((f) => f.path)
    screenPrsStore.addComment(url, {
      source: 'overview',
      file: ref ? (resolveRefPath(paths, ref.path) ?? ref.path) : '',
      line: ref?.line,
      text: `question: ${item.markdown}`,
      sha: overview?.headSha,
    })
  }

  const LABEL_CLASS: Record<TriageFinding['label'], string> = {
    issue: 'bg-red-500/15 text-red-300',
    suggestion: 'bg-blue-500/15 text-blue-300',
    question: 'bg-violet-500/15 text-violet-300',
    praise: 'bg-emerald-500/15 text-emerald-300',
    nitpick: 'bg-zinc-700 text-zinc-300',
    thought: 'bg-zinc-700 text-zinc-300',
    chore: 'bg-zinc-700 text-zinc-300',
  }
  const SEVERITY_CLASS: Record<DeepSeverity, string> = {
    blocking: 'bg-red-500/15 text-red-300',
    concern: 'bg-amber-500/15 text-amber-300',
    note: 'bg-zinc-700 text-zinc-300',
  }
  const CI_CLASS: Record<PrCiStatus, string> = {
    green: 'text-emerald-400',
    pending: 'text-amber-400',
    failing: 'text-red-400',
  }

  let activeLenses = $derived(DEEP_LENS_ORDER.filter((l) => deep?.lenses[l]))
</script>

<div class="flex h-full min-h-0 flex-col" data-testid="pr-detail">
  <div class="flex-none border-b border-zinc-800 px-3 pb-2">
    <div class="flex gap-1 rounded-lg border border-zinc-800 bg-zinc-900 p-1" role="group" aria-label="Pane">
      {#each PANES as p (p.id)}
        <button
          type="button"
          onclick={() => (pane = p.id)}
          aria-pressed={pane === p.id}
          data-testid="pane-{p.id}"
          class="min-h-9 flex-1 rounded-md text-[12px] {pane === p.id ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400'}"
        >{p.label}</button>
      {/each}
    </div>
  </div>

  <!-- Hidden, never unmounted: see the note at the top of this file. -->
  <div class="min-h-0 flex-1 overflow-y-auto {pane === 'conversation' ? '' : 'hidden'}">
    <div class="flex flex-col gap-3 p-3" data-testid="pane-conversation">
      <section>
        <h2 class="text-sm leading-snug text-zinc-100">{pr.title}</h2>
        <p class="mt-1 flex flex-wrap gap-x-2.5 gap-y-1 text-[11px] text-zinc-500">
          <span class="font-mono text-zinc-400">{pr.repo}#{pr.number}</span>
          <span>{pr.author}</span>
          {#if context}
            <span class="tabular-nums"
              ><b class="text-emerald-500">+{context.additions}</b>
              <b class="text-red-500">−{context.deletions}</b> · {context.changedFiles} files</span
            >
            <span class={CI_CLASS[context.ci]}>
              {context.ci === 'failing' && context.ciFailing.length
                ? `CI: ${context.ciFailing.join(', ')}`
                : `CI ${context.ci}`}
            </span>
            <span>base {context.baseRefName}</span>
          {/if}
        </p>
        {#if context?.reviewers.length}
          <p class="mt-1 text-[11px] text-zinc-500">
            {#each context.reviewers as r (r.login)}<span class="mr-2">{r.login} · {r.state}</span>{/each}
          </p>
        {/if}
      </section>

      {#if warning}
        <p class="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-[12px] leading-relaxed text-amber-200" data-testid="base-warning">
          {warning}
        </p>
      {/if}

      <div class="flex gap-2">
        <button
          type="button"
          onclick={runOverview}
          disabled={!context || !diff || overview?.status === 'running'}
          data-testid="run-overview"
          class="min-h-10 flex-1 rounded-lg border border-zinc-700 bg-zinc-800 px-3 text-[12px] font-medium text-zinc-200
                 disabled:opacity-50"
        >
          {overview?.status === 'running' ? '☰ Writing…' : overview?.status === 'done' ? '☰ Overview again' : '☰ Overview'}
        </button>
        <button
          type="button"
          onclick={runDeep}
          disabled={!context || !diff || deep?.status === 'running'}
          data-testid="run-deep"
          class="min-h-10 flex-1 rounded-lg border border-zinc-700 bg-zinc-800 px-3 text-[12px] font-medium text-zinc-200
                 disabled:opacity-50"
        >
          {deep?.status === 'running'
            ? '⚡ Deep review running…'
            : deep?.status === 'done'
              ? '⚡ Run deep review again'
              : '⚡ Deep review'}
        </button>
      </div>
      {#if deep?.status === 'running'}
        <p class="-mt-1.5 text-[11px] leading-relaxed text-zinc-500">
          Takes a few minutes. You can leave this screen — the findings land here when they’re ready.
        </p>
      {/if}

      {#if context && overview && overview.status !== 'idle'}
        <OverviewCard {context} {overview} initiallyOpen={['what']} onref={showRef} onreview={addOverview} />
      {/if}

      {#if context?.body?.trim()}
        <section class="rounded-lg border border-zinc-800 bg-zinc-900 p-3">
          <h3 class="mb-1.5 text-[10px] uppercase tracking-wider text-zinc-600">Description</h3>
          <p class="whitespace-pre-wrap break-words text-[12px] leading-relaxed text-zinc-300">{context.body}</p>
        </section>
      {/if}

      <section class="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900" data-testid="triage-findings">
        <h3 class="border-b border-zinc-800 px-3 py-2 text-[10px] uppercase tracking-wider text-orange-300/80">
          Triage
        </h3>
        {#if !card}
          <p class="px-3 py-3 text-[11px] italic text-zinc-500">Still screening…</p>
        {:else if card.findings.length === 0}
          <p class="px-3 py-3 text-[11px] text-zinc-500">No concrete concerns surfaced in triage.</p>
        {:else}
          {#each card.findings as f (f.file + f.title)}
            <div class="flex items-start gap-2 border-b border-zinc-800/60 px-3 py-2.5 last:border-b-0">
              <span class="mt-0.5 flex-none rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase {LABEL_CLASS[f.label]}"
                >{f.label}</span
              >
              <span class="min-w-0 flex-1">
                <span class="block text-[12px] text-zinc-100">{f.title}</span>
                <span class="block truncate font-mono text-[10px] text-zinc-500">{f.file}{f.line ? `:${f.line}` : ''}</span>
              </span>
              <button
                type="button"
                onclick={() => addTriage(f)}
                data-testid="add-triage"
                class="min-h-8 flex-none rounded border border-zinc-700 bg-zinc-800 px-2 text-[11px] text-zinc-300"
              >＋</button>
            </div>
          {/each}
        {/if}
      </section>

      {#if deep && deep.status !== 'idle'}
        <section class="overflow-hidden rounded-lg border border-blue-500/25 bg-zinc-900" data-testid="deep-findings">
          <div class="flex flex-wrap items-center gap-1.5 border-b border-zinc-800 px-3 py-2">
            <h3 class="mr-1 text-[10px] uppercase tracking-wider text-blue-300">Deep review</h3>
            {#each activeLenses as l (l)}
              {@const st = deep.lenses[l]}
              <span
                class="rounded px-1.5 py-0.5 text-[9.5px]
                  {st === 'done' ? 'bg-emerald-500/12 text-emerald-300' : st === 'error' ? 'bg-red-500/12 text-red-300' : 'bg-zinc-800 text-zinc-400'}"
              >{st === 'done' ? '✓' : st === 'error' ? '✕' : '…'} {DEEP_LENS_LABEL[l]}</span>
            {/each}
          </div>
          {#if deep.status === 'error'}
            <p class="px-3 py-3 text-[11px] text-red-400">Deep review failed: {deep.error}</p>
          {:else if deep.status === 'running'}
            <p class="px-3 py-3 text-[11px] text-zinc-500">Running…</p>
          {:else if deep.findings.length === 0}
            <p class="px-3 py-3 text-[11px] text-zinc-500">Deep review found nothing worth flagging.</p>
          {:else}
            {#each deep.findings as f (f.lens + f.file + f.title)}
              <div class="flex items-start gap-2 border-b border-zinc-800/60 px-3 py-2.5 last:border-b-0">
                <span class="mt-0.5 flex-none rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase {SEVERITY_CLASS[f.severity]}"
                  >{f.severity}</span
                >
                <span class="min-w-0 flex-1">
                  <span class="block text-[12px] font-medium text-zinc-100">{f.title}</span>
                  <span class="block truncate font-mono text-[10px] text-zinc-500"
                    >{f.file}{f.line ? `:${f.line}` : ''} · {DEEP_LENS_LABEL[f.lens]}</span
                  >
                  <span class="mt-1 block text-[11px] leading-relaxed text-zinc-400">{f.detail}</span>
                </span>
                <button
                  type="button"
                  onclick={() => addDeep(f)}
                  data-testid="add-deep"
                  class="min-h-8 flex-none rounded border border-zinc-700 bg-zinc-800 px-2 text-[11px] text-zinc-300"
                >＋</button>
              </div>
            {/each}
          {/if}
        </section>
      {/if}
    </div>
  </div>

  <div class="min-h-0 flex-1 overflow-y-auto {pane === 'files' ? '' : 'hidden'}" data-testid="pane-files-body">
    {#if diffError}
      <p class="p-4 text-[12px] leading-relaxed text-red-300" data-testid="diff-error">
        Couldn’t fetch the diff: {diffError}
      </p>
    {:else if !headSha}
      <p class="p-4 text-[12px] text-zinc-500" data-testid="diff-waiting">
        Waiting for this PR to finish screening…
      </p>
    {:else if !connected && !diff}
      <p class="p-4 text-[12px] text-zinc-500" data-testid="diff-offline">
        Waiting for the connection to come back…
      </p>
    {:else if loadingDiff}
      <p class="p-4 text-[12px] text-zinc-500" data-testid="diff-loading">Fetching the diff…</p>
    {:else}
      <PrDiff bind:this={prDiff} {diff} comments={draft.comments} oncomment={openCompose} onedit={openEdit} />
    {/if}
  </div>

  <PrReviewSheet {pr} {draft} {rawDraft} {headSha} {isolatedBase} {diff} {anchors} {connected} />
</div>

{#if target && nav.has(composeId)}
  <ComposeSheet
    bind:this={composeSheet}
    title={where(target.file, target.line, target.side)}
    snippet={target.snippet}
    sendLabel="Add"
    placeholder="What about this line?"
    onadd={addLineComment}
    onclose={() => nav.close(composeId)}
  />
{:else if editing && nav.has(composeId)}
  {@const id = editing.id}
  <ComposeSheet
    bind:this={composeSheet}
    title={where(editing.file, editing.line, editing.side)}
    snippet={editing.snippet}
    initial={editing.text}
    sendLabel="Save"
    placeholder="What about this line?"
    onadd={(text) => screenPrsStore.updateComment(url, id, { text })}
    ondelete={() => screenPrsStore.removeComment(url, id)}
    onclose={() => nav.close(composeId)}
  />
{/if}
