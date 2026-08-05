<script lang="ts">
  /**
   * Read-only unified-diff renderer: one card per file, git plumbing already
   * stripped by `parseUnifiedDiff`, rows syntax-highlighted with Monaco's
   * `colorize` (text only — no editor, no second file version needed).
   *
   * Shared by the screen-PRs detail view and the gen-UI `DiffBlock`, which is
   * why it takes parsed files and knows nothing about PRs or panel actions.
   */
  import * as monaco from 'monaco-editor'
  import type { Snippet } from 'svelte'
  import { languageForPath, type DiffFile } from '../../lib/parseDiff'

  interface Props {
    files: DiffFile[]
    /**
     * Highlight every file as this language instead of guessing from the path.
     * For embedded DSLs the extension lies — a shell script inside a `.ts`
     * template literal is not TypeScript.
     */
    language?: string
    /** Extra chrome for a file's header row (e.g. a jump-to-file link). */
    fileHeaderExtra?: Snippet<[DiffFile]>
    emptyLabel?: string
  }

  let { files, language, fileHeaderExtra, emptyLabel = 'No diff.' }: Props = $props()

  // ── syntax highlighting (Monaco colorize; falls back to plain on any miss) ──
  // Map<file path, HTML per row index>. Recomputed when the diff changes.
  let highlighted = $state<Map<string, string[]>>(new Map())

  function escapeHtml(s: string): string {
    return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string)
  }

  $effect(() => {
    const fs = files
    const langOverride = language
    let cancelled = false
    void (async () => {
      // colorize() uses Monaco's global theme (defaults to light until an editor
      // mounts); the app standardizes on vs-dark, so match it for readable colors.
      monaco.editor.setTheme('vs-dark')
      const next = new Map<string, string[]>()
      for (const f of fs) {
        if (f.binary) continue
        const lang = langOverride ?? languageForPath(f.path)
        const codeLines = f.rows.map((r) => (r.kind === 'hunk' ? '' : r.text))
        try {
          const html = await monaco.editor.colorize(codeLines.join('\n'), lang, { tabSize: 2 })
          const parts = html.split(/<br\/?>/)
          if (parts.length >= codeLines.length) next.set(f.path, codeLines.map((_, i) => parts[i]))
        } catch {
          /* leave unset → escaped plain text */
        }
      }
      if (!cancelled) highlighted = next
    })()
    return () => {
      cancelled = true
    }
  })

  function rowHtml(f: DiffFile, i: number, text: string): string {
    return highlighted.get(f.path)?.[i] ?? escapeHtml(text)
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
</script>

<div class="flex min-w-0 flex-col gap-3">
  {#each files as f (f.path)}
    {@const badge = STATUS_BADGE[f.status]}
    <div class="min-w-0 overflow-hidden rounded-lg border border-zinc-800">
      <div class="flex items-center gap-2 border-b border-zinc-800 bg-zinc-900 px-3 py-1.5 font-mono text-[11px]">
        {#if f.oldPath}<span class="text-zinc-500">{f.oldPath} →</span>{/if}
        <span class="truncate text-zinc-200">{f.path}</span>
        {#if badge.t}<span class="rounded bg-zinc-800 px-1.5 text-[9px] uppercase tracking-wide {badge.c}">{badge.t}</span>{/if}
        <span class="ml-auto flex-none tabular-nums text-[10px]"><span class="text-emerald-400">+{f.additions}</span> <span class="text-red-400">−{f.deletions}</span></span>
        {@render fileHeaderExtra?.(f)}
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
    <div class="rounded-lg border border-zinc-800 px-3 py-2 text-[11px] text-zinc-500">{emptyLabel}</div>
  {/if}
</div>
