<script lang="ts">
  import type { ScreenPrCard, PrContext, TriageFinding } from '../../../shared/screenprs'

  // The card carries the full diff + findings already, so the detail needs no
  // extra IPC. `card` is present once triage finished; `context` always is.
  let { context, card }: { context: PrContext; card?: ScreenPrCard } = $props()

  interface DiffLine {
    kind: 'add' | 'del' | 'hunk' | 'ctx' | 'meta'
    text: string
  }

  let diffLines = $derived.by<DiffLine[]>(() =>
    context.diff.split('\n').map((line) => {
      if (line.startsWith('@@')) return { kind: 'hunk', text: line }
      if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index '))
        return { kind: 'meta', text: line }
      if (line.startsWith('+')) return { kind: 'add', text: line }
      if (line.startsWith('-')) return { kind: 'del', text: line }
      return { kind: 'ctx', text: line }
    })
  )

  const LABEL_CLASS: Record<TriageFinding['label'], string> = {
    issue: 'bg-red-500/15 text-red-300',
    suggestion: 'bg-blue-500/15 text-blue-300',
    question: 'bg-violet-500/15 text-violet-300',
    praise: 'bg-emerald-500/15 text-emerald-300',
    nitpick: 'bg-zinc-700 text-zinc-300',
    thought: 'bg-zinc-700 text-zinc-300',
    chore: 'bg-zinc-700 text-zinc-300',
  }

  const DIFF_LINE_CLASS: Record<DiffLine['kind'], string> = {
    add: 'bg-emerald-500/10 text-emerald-300',
    del: 'bg-red-500/10 text-red-300',
    hunk: 'text-zinc-500',
    meta: 'text-zinc-600',
    ctx: 'text-zinc-400',
  }

  function openExternal(): void {
    void window.api.invoke('app:open-external', context.url)
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
  </div>

  <div class="flex-1 overflow-y-auto">
    <!-- Triage findings -->
    <div class="m-4 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900">
      <div class="border-b border-zinc-800 px-3 py-2 text-[11px] text-zinc-400">
        <span class="rounded border border-orange-400/30 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-orange-300/80"
          >Triage</span
        >
        <span class="ml-2">diff-only quick review</span>
      </div>
      {#if !card}
        <div class="px-3 py-3 text-[11px] italic text-zinc-500">Screening…</div>
      {:else if card.findings.length === 0}
        <div class="px-3 py-3 text-[11px] text-zinc-500">No concrete concerns surfaced in triage.</div>
      {:else}
        {#each card.findings as f (f.file + f.title)}
          <div class="flex gap-2.5 border-b border-zinc-800/60 px-3 py-2 last:border-b-0">
            <span class="h-fit rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase {LABEL_CLASS[f.label]}"
              >{f.label}</span
            >
            <div class="min-w-0">
              <div class="text-xs text-zinc-100">{f.title}</div>
              <div class="font-mono text-[10px] text-zinc-500">{f.file}{f.line ? ':' + f.line : ''}</div>
            </div>
          </div>
        {/each}
      {/if}
    </div>

    <!-- Diff (read-only, from gh pr diff) -->
    <div class="m-4 overflow-hidden rounded-lg border border-zinc-800">
      <div class="flex items-center gap-2 border-b border-zinc-800 bg-zinc-900 px-3 py-2 font-mono text-[11px] text-zinc-400">
        📄 diff
        <span class="ml-auto rounded border border-zinc-800 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-zinc-600"
          >read-only · gh pr diff</span
        >
      </div>
      <div class="overflow-x-auto bg-zinc-950 py-1 font-mono text-[11.5px] leading-relaxed">
        {#each diffLines as l, i (i)}
          <div class="whitespace-pre px-3 {DIFF_LINE_CLASS[l.kind]}">{l.text || ' '}</div>
        {/each}
      </div>
    </div>
  </div>
</div>
