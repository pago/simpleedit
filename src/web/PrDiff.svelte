<script lang="ts">
  /**
   * The diff, with every line a tap target.
   *
   * A tap anchors to the side of the diff the row lives on: a deletion exists
   * only in the old file, so it anchors to its OLD number on `LEFT`; an
   * addition or a context line anchors to its new number on `RIGHT`. The
   * gutter shows the number the anchor will use, so a deleted row reads its
   * old number rather than nothing.
   *
   * Tapping a draft comment under its line edits it.
   */
  import { tick } from 'svelte'
  import { parseUnifiedDiff, type DiffFile, type DiffRow } from '../shared/parseDiff'
  import { findRevealTarget, REVEAL_FLASH_MS, scrollBehavior, type RevealTarget } from '../renderer/lib/diffReveal'
  import { parseLineAnchor, type PrReviewComment } from '../shared/screenprs'
  import type { CommentTarget } from './lib/prs.svelte'

  interface Props {
    diff: string
    /** Draft comments, so the ones already made show under their line. */
    comments: PrReviewComment[]
    oncomment: (target: CommentTarget) => void
    onedit: (comment: PrReviewComment) => void
  }

  let { diff, comments, oncomment, onedit }: Props = $props()

  let files = $derived<DiffFile[]>(parseUnifiedDiff(diff))
  /**
   * A small PR opens read-to-go; a large one opens as a table of contents,
   * because scrolling past forty collapsed headers beats scrolling past four
   * thousand lines.
   */
  let autoExpand = $derived(files.length > 0 && files.length <= 5)
  /** Per-file override of `autoExpand`; absent means "whatever the PR's size says". */
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

  function tap(file: DiffFile, row: DiffRow): void {
    if (row.kind === 'hunk') return
    const left = row.kind === 'del'
    const n = left ? row.oldNo : row.newNo
    if (n === undefined) return
    oncomment({ file: file.path, line: String(n), side: left ? 'LEFT' : 'RIGHT', snippet: row.text })
  }

  let root = $state<HTMLDivElement>()
  let revealed = $state<RevealTarget | null>(null)
  let revealTimer: ReturnType<typeof setTimeout> | undefined

  /**
   * Scroll `path` into view and briefly highlight it: the row nearest `line`
   * (a new-file number, or a `12-18` range) when given, else the file header.
   * Opens a collapsed file and un-truncates a long one when the row needs it.
   * Resolves false when the diff has no such file. Call it with the Files pane
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

  /**
   * Draft comments already anchored to this exact line. A context row carries
   * both numbers, and each side is matched against its own: old line 12 and
   * new line 12 are different lines.
   */
  function commentsOn(file: DiffFile, row: DiffRow): PrReviewComment[] {
    return comments.filter((c) => {
      if (c.file !== file.path) return false
      const n = c.side === 'LEFT' ? row.oldNo : row.newNo
      return n !== undefined && parseLineAnchor(c.line) === n
    })
  }
</script>

<div class="flex flex-col gap-3 p-3" data-testid="pr-diff" bind:this={root}>
  {#if files.length === 0}
    <p class="px-1 py-4 text-sm text-zinc-500">No textual changes in this diff.</p>
  {/if}

  {#each files as file (file.path)}
    {@const open = isOpen(file.path)}
    {@const all = shownAll.has(file.path)}
    {@const rows = all ? file.rows : file.rows.slice(0, ROW_BUDGET)}
    <section class="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900" data-testid="diff-file">
      <button
        type="button"
        onclick={() => toggle(file.path)}
        data-testid="diff-file-header"
        data-revealed={isRevealed(file, null) || undefined}
        class="flex w-full items-center gap-2 border-b border-zinc-800 px-3 py-2.5 text-left {isRevealed(file, null) ? REVEAL_CLASS : ''}"
      >
        <span class="flex-none text-[10px] text-zinc-600">{open ? '▾' : '▸'}</span>
        <span class="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-300">{file.path}</span>
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
                    <div class="whitespace-pre px-3 py-1 {ROW_CLASS.hunk}">{row.text}</div>
                  {:else}
                    <button
                      type="button"
                      onclick={() => tap(file, row)}
                      data-testid="diff-line"
                      data-file={file.path}
                      data-line={row.newNo ?? ''}
                      data-revealed={isRevealed(file, i) || undefined}
                      class="flex w-full min-w-full items-start gap-2 whitespace-pre px-2 py-[3px] text-left active:bg-zinc-700/60 {ROW_CLASS[row.kind]} {isRevealed(file, i) ? REVEAL_ROW_CLASS : ''}"
                    >
                      <span class="w-9 flex-none select-none text-right text-[10px] text-zinc-600 tabular-nums"
                        >{row.kind === 'del' ? row.oldNo : row.newNo}</span
                      >
                      <span class="flex-none">{row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ' '}</span>
                      <span>{row.text}</span>
                    </button>
                  {/if}
                  {#each commentsOn(file, row) as c (c.id)}
                    <button
                      type="button"
                      onclick={() => onedit(c)}
                      aria-label="Edit comment"
                      class="mx-2 my-1 block w-[calc(100%-1rem)] rounded-md border border-blue-500/30 bg-blue-500/10 px-2.5 py-1.5 text-left font-sans text-[11px] leading-relaxed text-blue-100 active:bg-blue-500/20"
                      data-testid="inline-comment"
                    >
                      <span class="mr-1.5 rounded bg-blue-500/25 px-1 py-0.5 text-[8.5px] font-bold uppercase">{c.source}</span
                      >{c.text}
                    </button>
                  {/each}
                </li>
              {/each}
            </ul>
          </div>
          {#if !all && file.rows.length > ROW_BUDGET}
            <button
              type="button"
              onclick={() => { shownAll = new Set(shownAll).add(file.path) }}
              data-testid="show-all-rows"
              class="w-full border-t border-zinc-800 px-3 py-2.5 text-[11px] text-blue-400"
            >Show the remaining {file.rows.length - ROW_BUDGET} lines</button>
          {/if}
        {/if}
      {/if}
    </section>
  {/each}
</div>
