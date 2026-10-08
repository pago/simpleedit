<script lang="ts">
  /**
   * A unified diff at phone width: the one phone diff, under both the session's
   * Changes pane (`SessionDiff`, agent threads) and Screen PRs (`PrDiff`, review
   * drafts). Each wrapper decides what a tap on a line means and what shows
   * under it; this decides how a diff reads on a phone.
   *
   * Unified because there is no second column to put anything in: a
   * side-by-side split at ~390 CSS px gives each side about twenty characters,
   * which is not a diff, it is a puzzle. Long lines scroll inside their own
   * file's container so the PAGE never moves sideways — a horizontally
   * scrolling page on a touch screen fights every vertical swipe.
   *
   * Without `ontap` no row is a tap target, because a row that lights up under
   * a thumb promises an action. With it, `tappable` says which rows are: a
   * full-width row is the touch target, as tall as the text (a 44 px line would
   * leave a screenful of diff at fifteen lines).
   *
   * The gutter shows the number a comment on the row would use: a deletion
   * exists only in the old file, so it reads its OLD number; `data-line` is
   * always the new-file number, empty for a deletion.
   */
  import { tick, type Snippet } from 'svelte'
  import { parseUnifiedDiff, type DiffFile, type DiffRow } from '../shared/parseDiff'
  import { findRevealTarget, REVEAL_FLASH_MS, scrollBehavior, type RevealTarget } from '../renderer/lib/diffReveal'

  interface Props {
    diff: string
    testid?: string
    /** A line was tapped. Absent: the diff is read-only. */
    ontap?: (file: DiffFile, row: DiffRow) => void
    /** Which non-hunk rows `ontap` takes. Default: all of them. */
    tappable?: (row: DiffRow) => boolean
    /** Rendered under a row: comments, threads, a composer. */
    below?: Snippet<[DiffFile, DiffRow]>
  }

  let { diff, testid = 'session-diff', ontap, tappable = () => true, below }: Props = $props()

  let files = $derived<DiffFile[]>(parseUnifiedDiff(diff))

  /**
   * A small change opens ready to read; a large one opens as a table of
   * contents, because scrolling past forty collapsed headers beats scrolling
   * past four thousand lines to reach the one file you came for.
   */
  let autoExpand = $derived(files.length > 0 && files.length <= 5)
  /** Per-file override of `autoExpand`; absent means "whatever the size says". */
  let override = $state<Map<string, boolean>>(new Map())
  const isOpen = (path: string): boolean => override.get(path) ?? autoExpand

  function toggle(path: string): void {
    const next = new Map(override)
    next.set(path, !isOpen(path))
    override = next
  }

  /** Rows rendered before a file needs an explicit "show the rest" tap. */
  const ROW_BUDGET = 500
  let shownAll = $state<Set<string>>(new Set())

  const ROW_CLASS: Record<DiffRow['kind'], string> = {
    add: 'bg-emerald-500/10 text-emerald-200',
    del: 'bg-red-500/10 text-red-200',
    ctx: 'text-zinc-400',
    hunk: 'bg-zinc-800/70 text-zinc-500',
  }

  function marker(kind: DiffRow['kind']): string {
    return kind === 'add' ? '+' : kind === 'del' ? '−' : ' '
  }

  let root = $state<HTMLDivElement>()
  let revealed = $state<RevealTarget | null>(null)
  let revealTimer: ReturnType<typeof setTimeout> | undefined

  /**
   * Scroll `path` into view and briefly highlight it: the row nearest `line`
   * (a new-file number, or a `12-18` range) when given, else the file header.
   * Opens a collapsed file and un-truncates a long one when the row needs it.
   * Resolves false when the diff has no such file. Call it with the diff
   * showing — a hidden pane has nothing to scroll.
   */
  export async function reveal(path: string, line?: string | number): Promise<boolean> {
    const target = findRevealTarget(files, path, line)
    if (!target) return false
    if (!isOpen(target.path)) override = new Map(override).set(target.path, true)
    if (target.row !== null && target.row >= ROW_BUDGET) shownAll = new Set(shownAll).add(target.path)
    clearTimeout(revealTimer)
    revealed = target
    await tick()
    root?.querySelector('[data-revealed]')?.scrollIntoView({ block: 'center', behavior: scrollBehavior() })
    revealTimer = setTimeout(() => (revealed = null), REVEAL_FLASH_MS)
    return true
  }

  $effect(() => () => clearTimeout(revealTimer))

  const isRevealed = (file: DiffFile, row: number | null): boolean =>
    revealed?.path === file.path && revealed.row === row
  const REVEAL_CLASS = 'bg-orange-500/15 ring-1 ring-inset ring-orange-500/70'
  /** A row keeps its add/del tint, which a second background would fight; the ring alone marks it. */
  const REVEAL_ROW_CLASS = 'ring-2 ring-inset ring-orange-500/70'
  const ROW = 'flex w-full min-w-full items-start gap-2 whitespace-pre px-2 py-[3px] text-left'
</script>

<!-- Keyed by position, not by path: a parsed path is display data, and the
     whole list is re-derived from scratch whenever the diff string changes. -->
<div class="flex flex-col gap-3 p-3" data-testid={testid} bind:this={root}>
  {#if files.length === 0}
    <p class="px-1 py-4 text-sm text-zinc-500" data-testid="diff-empty">No textual changes here.</p>
  {/if}

  {#each files as file, index (index)}
    {@const open = isOpen(file.path)}
    {@const all = shownAll.has(file.path)}
    {@const rows = all ? file.rows : file.rows.slice(0, ROW_BUDGET)}
    <section class="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900" data-testid="diff-file">
      <button
        type="button"
        onclick={() => toggle(file.path)}
        data-testid="diff-file-header"
        data-revealed={isRevealed(file, null) || undefined}
        aria-expanded={open}
        class="flex min-h-11 w-full items-center gap-2 border-b border-zinc-800 px-3 py-2.5 text-left {isRevealed(file, null) ? REVEAL_CLASS : ''}"
      >
        <span class="flex-none text-[10px] text-zinc-600">{open ? '▾' : '▸'}</span>
        <span class="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-300">{file.path}</span>
        {#if file.status !== 'modified'}
          <span class="flex-none rounded bg-zinc-800 px-1 py-0.5 text-[9px] uppercase text-zinc-400"
            >{file.status}</span
          >
        {/if}
        <span class="flex-none text-[10px] tabular-nums">
          <b class="text-emerald-500">+{file.additions}</b>
          <b class="text-red-500">−{file.deletions}</b>
        </span>
      </button>

      {#if open}
        {#if file.binary}
          <p class="px-3 py-3 text-[11px] italic text-zinc-500">Binary file — no diff to show.</p>
        {:else}
          <div class="overflow-x-auto">
            <ul class="min-w-full font-mono text-[11px] leading-[1.6]">
              {#each rows as row, i (i)}
                <li>
                  {#if row.kind === 'hunk'}
                    <div class="whitespace-pre px-3 py-1 {ROW_CLASS.hunk}" data-testid="diff-hunk">{row.text}</div>
                  {:else}
                    {#snippet cells()}
                      <span class="w-9 flex-none select-none text-right text-[10px] tabular-nums text-zinc-600"
                        >{row.kind === 'del' ? row.oldNo : row.newNo}</span
                      >
                      <span class="flex-none">{marker(row.kind)}</span>
                      <span>{row.text}</span>
                    {/snippet}
                    {@const rowClass = `${ROW} ${ROW_CLASS[row.kind]} ${isRevealed(file, i) ? REVEAL_ROW_CLASS : ''}`}
                    {#if ontap && tappable(row)}
                      <button
                        type="button"
                        onclick={() => ontap(file, row)}
                        data-testid="diff-line"
                        data-file={file.path}
                        data-line={row.newNo ?? ''}
                        data-revealed={isRevealed(file, i) || undefined}
                        class="{rowClass} active:bg-zinc-700/60">{@render cells()}</button
                      >
                    {:else}
                      <div
                        data-testid="diff-line"
                        data-file={file.path}
                        data-line={row.newNo ?? ''}
                        data-revealed={isRevealed(file, i) || undefined}
                        class={rowClass}
                      >
                        {@render cells()}
                      </div>
                    {/if}
                  {/if}
                  {@render below?.(file, row)}
                </li>
              {/each}
            </ul>
          </div>
          {#if !all && file.rows.length > ROW_BUDGET}
            <button
              type="button"
              onclick={() => { shownAll = new Set(shownAll).add(file.path) }}
              data-testid="show-all-rows"
              class="min-h-11 w-full border-t border-zinc-800 px-3 py-2.5 text-[11px] text-blue-400"
              >Show the remaining {file.rows.length - ROW_BUDGET} lines</button
            >
          {/if}
        {/if}
      {/if}
    </section>
  {/each}
</div>
