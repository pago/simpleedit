<script lang="ts">
  import { onMount } from 'svelte'
  import type { ScreenPrCard, PrContext, TriageFinding, DeepFinding, DeepSeverity } from '../../../shared/screenprs'
  import { DEEP_LENS_ORDER, DEEP_LENS_LABEL } from '../../../shared/screenprs'
  import { screenPrsStore } from '../../stores/screenprs.svelte'
  import { parseUnifiedDiff, type DiffFile } from '../../lib/parseDiff'
  import UnifiedDiffView from '../diff/UnifiedDiffView.svelte'
  import ReviewComposer from './ReviewComposer.svelte'
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
      agentModels.find((m) => m.id === 'anthropic:claude-sonnet-5')?.id ??
      agentModels.find((m) => m.tier === 'cloud')?.id ??
      agentModels[0]?.id ??
      null
  })

  function buildBrief(): string {
    const lines = [
      `You are helping me review a GitHub pull request. This is a REVIEW session — the PR is NOT ours to modify unless I explicitly ask. When I'm ready, you'll post the review to GitHub yourself with \`gh pr review\` (approve / comment / request-changes). Don't post anything until I tell you to.`,
      ``,
      `PR: ${context.url}`,
      `${context.repo}#${context.number} — ${context.title}  (base ${context.baseRefName}, +${context.additions}/−${context.deletions}, ${context.changedFiles} files)`,
    ]
    const triage = card?.findings ?? []
    if (triage.length) {
      lines.push('', 'Triage (diff-only) flagged:')
      for (const f of triage) lines.push(`- [${f.label}] ${f.file}${f.line ? ':' + f.line : ''} — ${f.title}`)
    }
    const dv = deep?.findings ?? []
    if (dv.length) {
      lines.push('', 'Deep review flagged:')
      for (const f of dv) lines.push(`- [${f.severity}/${f.lens}] ${f.file}${f.line ? ':' + f.line : ''} — ${f.title}: ${f.detail}`)
    }
    lines.push(
      '',
      `Start by running \`gh pr diff ${context.url}\` to see the change (and \`gh pr checkout\` if you want to run it), then help me decide whether it's ready.`
    )
    return lines.join('\n')
  }

  function discuss(m: AgentModel): void {
    const wt = mainWorktree()
    const root = projectRoot() ?? wt?.path
    if (!root || !wt) return
    const id = sessionsStore.createAgent(m.target, root, wt.path, {
      ...(m.target.provider === 'claude' && m.target.model ? { model: m.target.model } : {}),
      initialPrompt: buildBrief(),
      label: `review ${context.repo}#${context.number}`,
    })
    uiView.show('workspace')
    sessionsStore.requestTerminalFocus(id)
  }

  let deep = $derived(screenPrsStore.deepFor(context.url))
  let triageExpanded = $state(false)
  let deepActive = $derived(deep != null && deep.status !== 'idle')
  let triageCollapsed = $derived(deepActive && !triageExpanded)
  let triageInProgress = $derived(!card)

  let files = $derived<DiffFile[]>(parseUnifiedDiff(context.diff))

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
  function addTriageComment(f: TriageFinding): void {
    screenPrsStore.addComment(context.url, { source: 'triage', file: f.file, line: f.line, text: f.title })
  }
  function addDeepComment(f: DeepFinding): void {
    screenPrsStore.addComment(context.url, {
      source: 'deep',
      file: f.file,
      line: f.line,
      text: f.detail ? `${f.title} — ${f.detail}` : f.title,
    })
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
      {#if agentModels.length}
        <SplitButton label="Discuss" icon="✦" models={agentModels} bind:selectedId={discussModelId} onstart={discuss} />
      {/if}
    </div>
  </div>

  <div class="flex-1 overflow-y-auto">
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
        {#if deepActive && card}
          <button class="ml-auto rounded px-1.5 py-0.5 text-[10.5px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300" onclick={() => (triageExpanded = !triageExpanded)}>
            {triageCollapsed ? `▸ ${card.findings.length} finding${card.findings.length !== 1 ? 's' : ''} · superseded by deep review` : '▾ hide (superseded)'}
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
              >＋ review</button>
            </div>
          {/each}
        {/if}
      </div>
    {/if}

    <!-- Diff — one section per file (git plumbing stripped, syntax-highlighted) -->
    <div class="mx-4 mb-6 mt-4">
      <UnifiedDiffView {files} />
    </div>
  </div>

  <!-- Decide: the review composer — the human path to GitHub (docked footer) -->
  <ReviewComposer {context} />
</div>
