<script lang="ts" module>
  type Side = 'LEFT' | 'RIGHT'
  interface Composing {
    url: string
    path: string
    side: Side
    /** The line first clicked; a shift-click spans from it to the new line. */
    anchor: number
    from: number
    to: number
    /** Set when editing a comment already in the draft. */
    editingId?: string
    initial: string
    text: string
  }

  /**
   * The open line editor of each PR, typed text included. Module-level so a
   * half-written comment survives switching PRs and the view remounting; it
   * is never persisted, since it is not in the draft yet.
   */
  const composingByUrl = $state<Record<string, Composing>>({})

  function setComposing(url: string, next: Composing | null): void {
    if (next) composingByUrl[url] = next
    else delete composingByUrl[url]
  }

  /** Tests only: forget every open editor. */
  export function _resetInlineEditors(): void {
    for (const url of Object.keys(composingByUrl)) delete composingByUrl[url]
  }
</script>

<script lang="ts">
  import { onMount } from 'svelte'
  import type { ScreenPrCard, PrContext, TriageFinding, DeepFinding, DeepSeverity, PrReviewComment } from '../../../shared/screenprs'
  import { DEEP_LENS_ORDER, DEEP_LENS_LABEL, anchorState, baseWarning, parseLineRange } from '../../../shared/screenprs'
  import { screenPrsStore } from '../../stores/screenprs.svelte'
  import { parseUnifiedDiff, type DiffFile, type DiffRow } from '../../../shared/parseDiff'
  import UnifiedDiffView from '../diff/UnifiedDiffView.svelte'
  import OverviewCard from './OverviewCard.svelte'
  import { resolveRefPath, type OverviewLookIntoItem, type OverviewRef } from '../../../shared/pr-overview'
  import ReviewComposer from './ReviewComposer.svelte'
  import InlineCommentEditor from './InlineCommentEditor.svelte'
  import { SOURCE_CLASS } from './commentSource'
  import SplitButton from '../SplitButton.svelte'
  import { loadAgentModels, type AgentModel } from '../../lib/agentModels'
  import { uiView } from '../../stores/uiView.svelte'
  import { sessionsStore } from '../../stores/sessions.svelte'
  import { projectRoot, mainWorktree } from '../../stores/worktrees.svelte'

  let { context, card }: { context: PrContext; card?: ScreenPrCard } = $props()

  // ── Discuss with Agent: spawn a primed Claude session in the sidebar ────────
  let agentModels = $state<AgentModel[]>([])
  let discussModelId = $state<string | null>(null)
  onMount(async () => {
    agentModels = await loadAgentModels()
    discussModelId =
      discussModelId ??
      agentModels.find((m) => m.id === 'anthropic:sonnet')?.id ??
      agentModels.find((m) => m.tier === 'cloud')?.id ??
      agentModels[0]?.id ??
      null
  })

  function buildBrief(focus?: OverviewLookIntoItem): string {
    const lines = [
      `You are helping me review a GitHub pull request. This is a REVIEW session — the PR is NOT ours to modify unless I explicitly ask. When I'm ready, you'll post the review to GitHub yourself with \`gh pr review\` (approve / comment / request-changes). Don't post anything until I tell you to.`,
      ``,
      `PR: ${context.url}`,
      `${context.repo}#${context.number} — ${context.title}  (base ${context.baseRefName}, +${context.additions}/−${context.deletions}, ${context.changedFiles} files)`,
    ]
    if (context.base?.kind === 'polluted') {
      lines.push('', `Careful: \`gh pr diff\` includes ${context.base.foreign} commit(s) from the lower stack layer. Review only this PR's own commits:`)
      for (const c of context.base.own) lines.push(`- ${c.sha.slice(0, 8)} ${c.subject}`)
    }
    const triage = card?.findings ?? []
    if (triage.length) {
      lines.push('', 'Triage (diff-only) flagged:')
      for (const f of triage) lines.push(`- [${f.label}] ${f.file}${f.line ? ':' + f.line : ''} — ${f.title}`)
    }
    if (overview?.text) {
      lines.push('', 'The PR overview (what changed, why, impact, what to look into):', '', overview.text)
    }
    const dv = deep?.findings ?? []
    if (dv.length) {
      lines.push('', 'Deep review flagged:')
      for (const f of dv) lines.push(`- [${f.severity}/${f.lens}] ${f.file}${f.line ? ':' + f.line : ''} — ${f.title}: ${f.detail}`)
    }
    if (focus) lines.push('', `I want to dig into this question from the overview first:`, focus.markdown)
    lines.push(
      '',
      `Start by running \`gh pr diff ${context.url}\` to see the change (and \`gh pr checkout\` if you want to run it), then help me decide whether it's ready.`
    )
    return lines.join('\n')
  }

  function discuss(m: AgentModel, focus?: OverviewLookIntoItem): void {
    const wt = mainWorktree()
    const root = projectRoot() ?? wt?.path
    if (!root || !wt) return
    const id = sessionsStore.createAgent(m.target, root, wt.path, {
      ...(m.target.provider === 'claude' && m.target.model ? { model: m.target.model } : {}),
      initialPrompt: buildBrief(focus),
      label: `review ${context.repo}#${context.number}`,
    })
    uiView.show('workspace')
    sessionsStore.requestTerminalFocus(id)
  }

  let deep = $derived(screenPrsStore.deepFor(context.url))
  let overview = $derived(screenPrsStore.overviewFor(context.url))
  let triageExpanded = $state(false)
  let deepActive = $derived(deep != null && deep.status !== 'idle')
  let overviewActive = $derived(overview != null && overview.status !== 'idle')
  let triageCollapsed = $derived((deepActive || overviewActive) && !triageExpanded)
  let supersededBy = $derived(deepActive ? 'deep review' : 'the overview')
  let triageInProgress = $derived(!card)

  let files = $derived<DiffFile[]>(parseUnifiedDiff(context.diff))
  let diffView = $state<UnifiedDiffView>()
  let warning = $derived(baseWarning(context))

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
  let activeLenses = $derived(DEEP_LENS_ORDER.filter((l) => deep?.lenses[l]))
  let lensesRunning = $derived(activeLenses.some((l) => deep?.lenses[l] === 'running'))

  // ＋ review: lift a finding into the composer draft as a line comment.
  // Each is stamped with the head ITS line was computed against: a triage
  // finding's card, or the commit the deep lenses ran over, which can be an
  // older head than the one on screen — deep findings outlive their card.
  function addTriageComment(f: TriageFinding): void {
    screenPrsStore.addComment(context.url, { source: 'triage', file: f.file, line: f.line, text: f.title, sha: card?.headSha })
  }
  function addDeepComment(f: DeepFinding): void {
    screenPrsStore.addComment(context.url, {
      source: 'deep',
      file: f.file,
      line: f.line,
      text: f.detail ? `${f.title} — ${f.detail}` : f.title,
      sha: deep?.headSha,
    })
  }

  function showRef(ref: OverviewRef): void {
    void diffView?.reveal(ref.path, ref.line)
  }
  // ＋ review on a Look-into item: a question anchored to its first citation,
  // the same composer path the findings take.
  function addOverviewComment(item: OverviewLookIntoItem): void {
    const ref = item.refs[0]
    screenPrsStore.addComment(context.url, {
      source: 'overview',
      file: ref ? (resolveRefPath(files.map((f) => f.path), ref.path) ?? ref.path) : '',
      line: ref?.line,
      text: `question: ${item.markdown}`,
      sha: overview?.headSha,
    })
  }
  function discussItem(item: OverviewLookIntoItem): void {
    const m = agentModels.find((a) => a.id === discussModelId) ?? agentModels[0]
    if (m) discuss(m, item)
  }
  function runOverview(): void {
    void screenPrsStore.startOverview(context)
  }

  // ── Inline comments: ＋ on a diff line opens an editor under it ─────────────
  let draft = $derived(screenPrsStore.draftFor(context.url))
  let active = $derived(composingByUrl[context.url] ?? null)
  let editor = $state<InlineCommentEditor>()
  let selectedRange = $derived(active ? { path: active.path, side: active.side, from: active.from, to: active.to } : undefined)

  // A deletion exists only in the old file, so it anchors to its old number on
  // LEFT; additions and context lines anchor to their new number on RIGHT.
  const sideOf = (row: DiffRow): Side => (row.kind === 'del' ? 'LEFT' : 'RIGHT')
  const lineOn = (row: DiffRow, side: Side): number | undefined => (side === 'LEFT' ? row.oldNo : row.newNo)

  function openEditor(next: Composing): void {
    if (active && editor) editor.confirmLeave(() => setComposing(next.url, next))
    else setComposing(next.url, next)
  }

  function lineClick(f: DiffFile, row: DiffRow, _index: number, ev: MouseEvent): void {
    const side = sideOf(row)
    const n = lineOn(row, side)
    if (n === undefined) return
    if (ev.shiftKey && active && !active.editingId && active.path === f.path && active.side === side) {
      setComposing(context.url, { ...active, from: Math.min(active.anchor, n), to: Math.max(active.anchor, n) })
      return
    }
    openEditor({ url: context.url, path: f.path, side, anchor: n, from: n, to: n, initial: '', text: '' })
  }

  function editComment(c: PrReviewComment): void {
    const range = parseLineRange(c.line)
    if (!range) return
    openEditor({
      url: context.url,
      path: c.file,
      side: c.side ?? 'RIGHT',
      anchor: range.start,
      from: range.start,
      to: range.end,
      editingId: c.id,
      initial: c.text,
      text: c.text,
    })
  }

  function submitInline(text: string): void {
    const a = active
    if (!a) return
    if (a.editingId) {
      screenPrsStore.updateComment(context.url, a.editingId, { text })
    } else {
      const rows = files.find((f) => f.path === a.path)?.rows ?? []
      const snippet = rows
        .filter((r) => {
          const n = lineOn(r, a.side)
          return r.kind !== 'hunk' && n !== undefined && n >= a.from && n <= a.to
        })
        .map((r) => r.text)
        .join('\n')
      screenPrsStore.addComment(context.url, {
        source: 'you',
        file: a.path,
        line: a.from === a.to ? String(a.from) : `${a.from}-${a.to}`,
        side: a.side,
        snippet,
        text,
        sha: context.headSha,
      })
    }
    setComposing(context.url, null)
  }

  function deleteInline(): void {
    if (active?.editingId) screenPrsStore.removeComment(context.url, active.editingId)
    setComposing(context.url, null)
  }

  /**
   * A comment sits under the last row it covers, matched on its own side's
   * numbers. Only one read off the head on screen: an older head's line
   * number would put it under different code.
   */
  function endsAt(c: PrReviewComment, f: DiffFile, row: DiffRow): boolean {
    if (c.file !== f.path || row.kind === 'hunk' || anchorState(c, context.headSha) !== 'current') return false
    const end = parseLineRange(c.line)?.end
    return end !== undefined && lineOn(row, c.side ?? 'RIGHT') === end
  }
  const commentsUnder = (f: DiffFile, row: DiffRow): PrReviewComment[] =>
    draft.comments.filter((c) => c.id !== active?.editingId && endsAt(c, f, row))
  const editorUnder = (f: DiffFile, row: DiffRow): boolean =>
    active !== null && active.path === f.path && row.kind !== 'hunk' && lineOn(row, active.side) === active.to

  /** Whether the comment's line is in this diff, so it can be revealed and edited in place. */
  function inDiff(c: PrReviewComment): boolean {
    const f = files.find((x) => x.path === c.file)
    return f?.rows.some((row) => endsAt(c, f, row)) ?? false
  }
  function revealComment(c: PrReviewComment): void {
    void diffView?.reveal(c.file, c.line, c.side)
  }
  function editFromComposer(c: PrReviewComment): void {
    revealComment(c)
    editComment(c)
  }

  function editorLabel(a: Composing): string {
    const lines = a.from === a.to ? `line ${a.from}` : `lines ${a.from}–${a.to}`
    return `Comment on ${a.side === 'LEFT' ? 'deleted ' : ''}${lines}`
  }

  function openExternal(): void {
    void window.api.invoke('app:open-external', context.url)
  }
  function runDeep(): void {
    void screenPrsStore.startDeep(context)
  }
</script>

<div class="flex h-full flex-col overflow-hidden">
  <!-- Header -->
  <div class="flex-none border-b border-zinc-800 bg-zinc-900 px-5 py-3">
    <h2 class="text-[15px] font-semibold text-zinc-100">{context.title}</h2>
    <div class="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-500">
      <span class="font-mono"><b class="text-zinc-300">{context.repo}</b>#{context.number}</span>
      <span>by {context.author}</span>
      <span class="tabular-nums">
        <b class="text-emerald-400">+{context.additions}</b>
        <b class="text-red-400">−{context.deletions}</b> · {context.changedFiles} files
      </span>
      <span>base: {context.baseRefName}</span>
      <button class="text-blue-400 hover:underline" onclick={openExternal}>↗ open on GitHub</button>
    </div>
    <div class="mt-2.5 flex items-center gap-2">
      <button
        class="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1 text-xs font-medium text-zinc-200 hover:bg-zinc-700 disabled:opacity-50"
        onclick={runDeep}
        disabled={deep?.status === 'running'}
      >
        {#if deep?.status === 'running'}⚡ Running…{:else if deep?.status === 'done'}✓ Deep review done{:else}⚡ Deep review{/if}
      </button>
      {#if deep?.status === 'running'}
        <button class="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800" onclick={() => screenPrsStore.cancelDeep(context.url)}>Stop</button>
      {/if}
      <button
        class="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1 text-xs font-medium text-zinc-200 hover:bg-zinc-700 disabled:opacity-50"
        onclick={runOverview}
        disabled={overview?.status === 'running' || !context.diff}
        data-testid="run-overview"
      >
        {#if overview?.status === 'running'}☰ Writing…{:else if overview?.status === 'done'}☰ Overview again{:else}☰ Overview{/if}
      </button>
      {#if overview?.status === 'running'}
        <button class="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800" onclick={() => screenPrsStore.cancelOverview(context.url)}>Stop</button>
      {/if}
      {#if agentModels.length}
        <SplitButton label="Discuss" icon="✦" models={agentModels} bind:selectedId={discussModelId} onstart={discuss} />
      {/if}
    </div>
  </div>

  <div class="flex-1 overflow-y-auto">
    {#if warning}
      <div class="mx-4 mt-4 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200" data-testid="base-warning">
        {warning}
      </div>
    {/if}
    {#if overviewActive && overview}
      <div class="mx-4 mt-4">
        <OverviewCard {context} {overview} onref={showRef} onreview={addOverviewComment} ondiscuss={agentModels.length ? discussItem : undefined} />
      </div>
    {/if}
    {#if triageInProgress}
      <div class="mx-4 mt-4 flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-[11px] text-zinc-400">
        <span class="h-3 w-3 animate-spin rounded-full border-2 border-zinc-700 border-t-blue-500"></span>
        Triage in progress — the diff is ready to read now; findings and bucket land when it finishes.
      </div>
    {/if}

    <!-- Triage findings (collapse once deep review supersedes them) -->
    <div class="m-4 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900" class:opacity-80={triageCollapsed}>
      <div class="flex items-center gap-2 border-b border-zinc-800 px-3 py-2 text-[11px] text-zinc-400">
        <span class="rounded border border-orange-400/30 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-orange-300/80">Triage</span>
        <span>diff-only quick review</span>
        {#if (deepActive || overviewActive) && card}
          <button class="ml-auto rounded px-1.5 py-0.5 text-[10.5px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300" onclick={() => (triageExpanded = !triageExpanded)}>
            {triageCollapsed ? `▸ ${card.findings.length} finding${card.findings.length !== 1 ? 's' : ''} · superseded by ${supersededBy}` : '▾ hide (superseded)'}
          </button>
        {/if}
      </div>
      {#if !triageCollapsed}
        {#if !card}
          <div class="flex items-center gap-2 px-3 py-3 text-[11px] italic text-zinc-500">
            <span class="h-3 w-3 animate-spin rounded-full border-2 border-zinc-700 border-t-blue-500"></span>Screening…
          </div>
        {:else if card.findings.length === 0}
          <div class="px-3 py-3 text-[11px] text-zinc-500">No concrete concerns surfaced in triage.</div>
        {:else}
          {#each card.findings as f (f.file + f.title)}
            <div class="group flex items-start gap-2.5 border-b border-zinc-800/60 px-3 py-2 last:border-b-0">
              <span class="h-fit rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase {LABEL_CLASS[f.label]}">{f.label}</span>
              <div class="min-w-0 flex-1">
                <div class="text-xs text-zinc-100">{f.title}</div>
                <div class="font-mono text-[10px] text-zinc-500">{f.file}{f.line ? ':' + f.line : ''}</div>
              </div>
              <button
                class="flex-none self-center rounded border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-400 opacity-0 transition-opacity hover:border-blue-500 hover:bg-blue-500/15 hover:text-blue-200 group-hover:opacity-100"
                title="Add to the review composer as a line comment"
                onclick={() => addTriageComment(f)}
                data-testid="add-triage"
              >＋ review</button>
            </div>
          {/each}
        {/if}
      {/if}
    </div>

    <!-- Deep review -->
    {#if deepActive && deep}
      <div class="m-4 overflow-hidden rounded-lg border border-blue-500/25 bg-zinc-900">
        <div class="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-3 py-2 text-[11px] text-zinc-400">
          <span class="rounded border border-blue-400/40 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-blue-300">Deep review</span>
          <span>multi-lens · synthesized</span>
          <div class="ml-auto flex flex-wrap items-center gap-1.5">
            {#each activeLenses as l (l)}
              {@const st = deep.lenses[l]}
              <span
                class="rounded px-1.5 py-0.5 text-[9.5px]
                  {st === 'done' ? 'bg-emerald-500/12 text-emerald-300' : st === 'error' ? 'bg-red-500/12 text-red-300' : 'bg-zinc-800 text-zinc-400'}"
                title={DEEP_LENS_LABEL[l]}
              >
                {st === 'done' ? '✓' : st === 'error' ? '✕' : '…'}
                {DEEP_LENS_LABEL[l]}
              </span>
            {/each}
          </div>
        </div>

        {#if deep.status === 'error'}
          <div class="px-3 py-3 text-[11px] text-red-400">Deep review failed: {deep.error}</div>
        {:else if deep.status === 'running'}
          <div class="flex items-center gap-2 px-3 py-3 text-[11px] text-zinc-500">
            <span class="h-3 w-3 animate-spin rounded-full border-2 border-zinc-700 border-t-blue-500"></span>
            {lensesRunning ? 'running lenses…' : 'synthesizing findings…'}
          </div>
        {:else if deep.findings.length === 0}
          <div class="px-3 py-3 text-[11px] text-zinc-500">Deep review found nothing worth flagging.</div>
        {:else}
          {#each deep.findings as f (f.lens + f.file + f.title)}
            <div class="group flex gap-2.5 border-b border-zinc-800/60 px-3 py-2.5 last:border-b-0">
              <span class="h-fit rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase {SEVERITY_CLASS[f.severity]}">{f.severity}</span>
              <div class="min-w-0 flex-1">
                <div class="text-xs font-medium text-zinc-100">{f.title}</div>
                <div class="font-mono text-[10px] text-zinc-500">{f.file}{f.line ? ':' + f.line : ''} · {DEEP_LENS_LABEL[f.lens]}</div>
                <div class="mt-1 text-[11px] leading-relaxed text-zinc-400">{f.detail}</div>
              </div>
              <button
                class="flex-none self-start rounded border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-400 opacity-0 transition-opacity hover:border-blue-500 hover:bg-blue-500/15 hover:text-blue-200 group-hover:opacity-100"
                title="Add to the review composer as a line comment"
                onclick={() => addDeepComment(f)}
                data-testid="add-deep"
              >＋ review</button>
            </div>
          {/each}
        {/if}
      </div>
    {/if}

    <!-- Diff — one section per file (git plumbing stripped, syntax-highlighted) -->
    <div class="mx-4 mb-6 mt-4">
      <UnifiedDiffView bind:this={diffView} {files} onLineClick={lineClick} {belowRow} {selectedRange} />
    </div>
  </div>

  <!-- Decide: the review composer — the human path to GitHub (docked footer) -->
  <ReviewComposer {context} editable={inDiff} onreveal={revealComment} onedit={editFromComposer} />
</div>

{#snippet belowRow(f: DiffFile, row: DiffRow)}
  {#each commentsUnder(f, row) as c (c.id)}
    <div class="mx-3 my-1 flex items-start gap-2 rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 font-sans" data-testid="inline-comment">
      <span class="mt-0.5 flex-none rounded px-1.5 py-0.5 text-[8.5px] font-bold uppercase tracking-wide {SOURCE_CLASS[c.source]}">{c.source}</span>
      <span class="min-w-0 flex-1 whitespace-pre-wrap text-[11.5px] text-zinc-200">{c.text}</span>
      <button type="button" class="flex-none rounded px-1.5 text-[10.5px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200" aria-label="Edit comment" onclick={() => editComment(c)}>Edit</button>
      <button type="button" class="flex-none rounded px-1 text-zinc-600 hover:bg-zinc-800 hover:text-red-400" aria-label="Remove comment" title="Remove" onclick={() => screenPrsStore.removeComment(context.url, c.id)}>✕</button>
    </div>
  {/each}
  {#if active && editorUnder(f, row)}
    <InlineCommentEditor
      bind:this={editor}
      bind:text={() => active?.text ?? '', (v) => { if (active) active.text = v }}
      initial={active.initial}
      label={editorLabel(active)}
      onsubmit={submitInline}
      oncancel={() => setComposing(context.url, null)}
      ondelete={active.editingId ? deleteInline : undefined}
    />
  {/if}
{/snippet}
