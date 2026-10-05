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
  import { tick, type Snippet } from 'svelte'
  import { languageForPath, type DiffFile, type DiffRow } from '../../../shared/parseDiff'
  import { findRevealTarget, REVEAL_FLASH_MS, scrollBehavior, type RevealTarget } from '../../lib/diffReveal'

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
    /** Offers a gutter ＋ on every line row; absent, the view stays read-only. */
    onLineClick?: (file: DiffFile, row: DiffRow, index: number, ev: MouseEvent) => void
    /** Content rendered under a line row (e.g. comments on it). */
    belowRow?: Snippet<[DiffFile, DiffRow, number]>
    /** Lines to highlight, counted on `side`: old-file numbers for LEFT, new-file for RIGHT. */
    selectedRange?: { path: string; side: 'LEFT' | 'RIGHT'; from: number; to: number }
  }

  let { files, language, fileHeaderExtra, emptyLabel = 'No diff.', onLineClick, belowRow, selectedRange }: Props = $props()

  let root = $state<HTMLDivElement>()
  let revealed = $state<RevealTarget | null>(null)
  let revealTimer: ReturnType<typeof setTimeout> | undefined

  /**
   * Scroll `path` into view and briefly highlight it: the row nearest `line`
   * (a new-file number, or a `12-18` range; old-file for `LEFT`) when given,
   * else the file header. Resolves false when the diff has no such file. Call
   * it with the view visible — a hidden container has nothing to scroll.
   */
  export async function reveal(path: string, line?: string | number, side?: 'LEFT' | 'RIGHT'): Promise<boolean> {
    const target = findRevealTarget(files, path, line, side)
    if (!target) return false
    clearTimeout(revealTimer)
    revealed = target
    await tick()
    root?.querySelector('[data-revealed]')?.scrollIntoView({ block: 'center', behavior: scrollBehavior() })
    revealTimer = setTimeout(() => (revealed = null), REVEAL_FLASH_MS)
    return true
  }

  $effect(() => () => clearTimeout(revealTimer))

  const isRevealed = (f: DiffFile, row: number | null): boolean =>
    revealed?.path === f.path && revealed.row === row
  const REVEAL_CLASS = 'bg-orange-500/15 ring-1 ring-inset ring-orange-500/70'

  function isSelected(f: DiffFile, row: DiffRow): boolean {
    const r = selectedRange
    if (!r || r.path !== f.path) return false
    const n = r.side === 'LEFT' ? row.oldNo : row.newNo
    return n !== undefined && n >= r.from && n <= r.to
  }
  const SELECTED_CLASS = 'bg-blue-500/[0.14]'

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

<div class="flex min-w-0 flex-col gap-3" bind:this={root}>
  {#each files as f (f.path)}
    {@const badge = STATUS_BADGE[f.status]}
    <div class="min-w-0 overflow-hidden rounded-lg border border-zinc-800">
      <div
        class="flex items-center gap-2 border-b border-zinc-800 px-3 py-1.5 font-mono text-[11px] {isRevealed(f, null) ? REVEAL_CLASS : 'bg-zinc-900'}"
        data-revealed={isRevealed(f, null) || undefined}
      >
        {#if f.oldPath}<span class="text-zinc-500">{f.oldPath} →</span>{/if}
        <span class="truncate text-zinc-200">{f.path}</span>
        {#if badge.t}<span class="rounded bg-zinc-800 px-1.5 text-[9px] uppercase tracking-wide {badge.c}">{badge.t}</span>{/if}
        <span class="ml-auto flex-none tabular-nums text-[10px]"><span class="text-emerald-400">+{f.additions}</span> <span class="text-red-400">−{f.deletions}</span></span>
        {@render fileHeaderExtra?.(f)}
      </div>
      {#if f.binary}
        <div class="px-3 py-2 font-mono text-[11px] text-zinc-500">Binary file not shown</div>
      {:else}
        <!-- pb-3: macOS draws an overlay scrollbar over the content, which
             would cover the last row and its ＋. -->
        <div class="overflow-x-auto bg-zinc-950 pb-3 font-mono text-[11.5px] leading-[1.5]">
          {#each f.rows as row, i (i)}
            {#if row.kind === 'hunk'}
              <div class="bg-zinc-900/60 px-3 py-0.5 text-[10.5px] text-zinc-500">⋯ {row.text}</div>
            {:else}
              <div
                class="flex {isRevealed(f, i) ? REVEAL_CLASS : isSelected(f, row) ? SELECTED_CLASS : ROW_BG[row.kind]}
                  {onLineClick ? 'group relative' : ''}"
                data-revealed={isRevealed(f, i) || undefined}
                data-selected={isSelected(f, row) || undefined}
              >
                {#if onLineClick}
                  {@const n = row.kind === 'del' ? row.oldNo : row.newNo}
                  <button
                    type="button"
                    class="absolute left-[4.1rem] top-1/2 z-10 flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded bg-blue-600 text-[11px] leading-none text-white opacity-0 shadow transition-opacity hover:bg-blue-500 focus-visible:opacity-100 group-hover:opacity-100"
                    aria-label="Comment on {row.kind === 'del' ? 'deleted ' : ''}line {n}"
                    title="Comment on this line (shift-click to extend a range)"
                    data-testid="diff-line-comment"
                    onclick={(ev) => onLineClick(f, row, i, ev)}
                  >＋</button>
                {/if}
                <span class="w-10 flex-none select-none border-r border-zinc-800/60 pr-2 text-right text-zinc-500 tabular-nums">{row.oldNo ?? ''}</span>
                <span class="w-10 flex-none select-none border-r border-zinc-800/60 pr-2 text-right text-zinc-500 tabular-nums">{row.newNo ?? ''}</span>
                <span class="w-4 flex-none select-none text-center {row.kind === 'add' ? 'text-emerald-400' : row.kind === 'del' ? 'text-red-400' : 'text-zinc-600'}">{row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ''}</span>
                <span class="whitespace-pre pl-2 pr-4 text-zinc-200">{@html rowHtml(f, i, row.text)}</span>
              </div>
              {#if belowRow}
                <!-- sticky so a comment stays in view when a wide row is scrolled sideways -->
                <div class="sticky left-0">{@render belowRow(f, row, i)}</div>
              {/if}
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
