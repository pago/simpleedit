<script lang="ts">
  import * as monaco from 'monaco-editor'
  import type { ScreenPrCard, PrContext, TriageFinding, DeepSeverity } from '../../../shared/screenprs'
  import { DEEP_LENS_ORDER, DEEP_LENS_LABEL } from '../../../shared/screenprs'
  import { screenPrsStore } from '../../stores/screenprs.svelte'
  import { parseUnifiedDiff, languageForPath, type DiffFile } from '../../lib/parseDiff'

  let { context, card }: { context: PrContext; card?: ScreenPrCard } = $props()

  let deep = $derived(screenPrsStore.deepFor(context.url))
  let triageExpanded = $state(false)
  let deepActive = $derived(deep != null && deep.status !== 'idle')
  let triageCollapsed = $derived(deepActive && !triageExpanded)
  let triageInProgress = $derived(!card)

  let files = $derived<DiffFile[]>(parseUnifiedDiff(context.diff))

  // ── syntax highlighting (Monaco colorize; falls back to plain on any miss) ──
  // Map<file path, HTML per row index>. Recomputed when the selected PR changes.
  let highlighted = $state<Map<string, string[]>>(new Map())
  function escapeHtml(s: string): string {
    return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string)
  }
  $effect(() => {
    const url = context.url
    const fs = files
    void (async () => {
      // colorize() uses Monaco's global theme (defaults to light until an editor
      // mounts); the app standardizes on vs-dark, so match it for readable colors.
      monaco.editor.setTheme('vs-dark')
      const next = new Map<string, string[]>()
      for (const f of fs) {
        if (f.binary) continue
        const lang = languageForPath(f.path)
        const codeLines = f.rows.map((r) => (r.kind === 'hunk' ? '' : r.text))
        try {
          const html = await monaco.editor.colorize(codeLines.join('\n'), lang, { tabSize: 2 })
          const parts = html.split(/<br\/?>/)
          if (parts.length >= codeLines.length) next.set(f.path, codeLines.map((_, i) => parts[i]))
        } catch {
          /* leave unset → escaped plain text */
        }
      }
      if (context.url === url) highlighted = next
    })()
  })
  function rowHtml(f: DiffFile, i: number, text: string): string {
    return highlighted.get(f.path)?.[i] ?? escapeHtml(text)
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
  // Subtle, desaturated tints (GitHub-like) so the vs-dark syntax colors stay readable.
  const ROW_BG: Record<'add' | 'del' | 'ctx', string> = {
    add: 'bg-emerald-500/[0.07]',
    del: 'bg-red-500/[0.07]',
    ctx: '',
  }
  const STATUS_BADGE: Record<DiffFile['status'], { t: string; c: string }> = {
    added: { t: 'added', c: 'text-emerald-400' },
    deleted: { t: 'deleted', c: 'text-red-400' },
    renamed: { t: 'renamed', c: 'text-blue-300' },
    modified: { t: '', c: '' },
  }

  let activeLenses = $derived(DEEP_LENS_ORDER.filter((l) => deep?.lenses[l]))
  let lensesRunning = $derived(activeLenses.some((l) => deep?.lenses[l] === 'running'))

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
            <div class="flex gap-2.5 border-b border-zinc-800/60 px-3 py-2 last:border-b-0">
              <span class="h-fit rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase {LABEL_CLASS[f.label]}">{f.label}</span>
              <div class="min-w-0">
                <div class="text-xs text-zinc-100">{f.title}</div>
                <div class="font-mono text-[10px] text-zinc-500">{f.file}{f.line ? ':' + f.line : ''}</div>
              </div>
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
            <div class="flex gap-2.5 border-b border-zinc-800/60 px-3 py-2.5 last:border-b-0">
              <span class="h-fit rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase {SEVERITY_CLASS[f.severity]}">{f.severity}</span>
              <div class="min-w-0 flex-1">
                <div class="text-xs font-medium text-zinc-100">{f.title}</div>
                <div class="font-mono text-[10px] text-zinc-500">{f.file}{f.line ? ':' + f.line : ''} · {DEEP_LENS_LABEL[f.lens]}</div>
                <div class="mt-1 text-[11px] leading-relaxed text-zinc-400">{f.detail}</div>
              </div>
            </div>
          {/each}
        {/if}
      </div>
    {/if}

    <!-- Diff — one section per file (git plumbing stripped, syntax-highlighted) -->
    <div class="mx-4 mb-6 mt-4 flex flex-col gap-3">
      {#each files as f (f.path)}
        {@const badge = STATUS_BADGE[f.status]}
        <div class="overflow-hidden rounded-lg border border-zinc-800">
          <div class="flex items-center gap-2 border-b border-zinc-800 bg-zinc-900 px-3 py-1.5 font-mono text-[11px]">
            {#if f.oldPath}<span class="text-zinc-500">{f.oldPath} →</span>{/if}
            <span class="text-zinc-200">{f.path}</span>
            {#if badge.t}<span class="rounded bg-zinc-800 px-1.5 text-[9px] uppercase tracking-wide {badge.c}">{badge.t}</span>{/if}
            <span class="ml-auto tabular-nums text-[10px]"><span class="text-emerald-400">+{f.additions}</span> <span class="text-red-400">−{f.deletions}</span></span>
          </div>
          {#if f.binary}
            <div class="px-3 py-2 font-mono text-[11px] text-zinc-500">Binary file not shown</div>
          {:else}
            <div class="overflow-x-auto bg-zinc-950 font-mono text-[11.5px] leading-[1.5]">
              {#each f.rows as row, i (i)}
                {#if row.kind === 'hunk'}
                  <div class="bg-zinc-900/60 px-3 py-0.5 text-[10.5px] text-zinc-500">⋯ {row.text}</div>
                {:else}
                  <div class="flex {ROW_BG[row.kind]}">
                    <span class="w-10 flex-none select-none border-r border-zinc-800/60 pr-2 text-right text-zinc-500 tabular-nums">{row.oldNo ?? ''}</span>
                    <span class="w-10 flex-none select-none border-r border-zinc-800/60 pr-2 text-right text-zinc-500 tabular-nums">{row.newNo ?? ''}</span>
                    <span class="w-4 flex-none select-none text-center {row.kind === 'add' ? 'text-emerald-400' : row.kind === 'del' ? 'text-red-400' : 'text-zinc-600'}">{row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ''}</span>
                    <span class="whitespace-pre pl-2 pr-4 text-zinc-200">{@html rowHtml(f, i, row.text)}</span>
                  </div>
                {/if}
              {/each}
            </div>
          {/if}
        </div>
      {/each}
      {#if files.length === 0}
        <div class="rounded-lg border border-zinc-800 px-3 py-2 text-[11px] text-zinc-500">No diff.</div>
      {/if}
    </div>
  </div>
</div>
