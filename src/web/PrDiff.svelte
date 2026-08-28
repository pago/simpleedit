<script lang="ts">
  /**
   * The diff, with every line a tap target.
   *
   * **Only a RIGHT-side line can be anchored.** `buildReviewPayload` posts
   * anchored comments with `side: 'RIGHT'`, so a line that exists only in the
   * old file — a deletion — has no line number GitHub would accept. Tapping one
   * is still allowed (a deletion is often exactly what you want to ask about),
   * but the comment is raised WITHOUT a line: `buildReviewPayload` folds it into
   * the review body with its file for context, which is the honest outcome
   * rather than an anchor that 422s and gets folded anyway.
   *
   * That rule is enforced here, at the tap, not asserted in the sheet's copy.
   */
  import { parseUnifiedDiff, type DiffFile, type DiffRow } from '../renderer/lib/parseDiff'
  import { parseLineAnchor, type PrReviewComment } from '../shared/screenprs'
  import type { CommentTarget } from './lib/prs.svelte'

  interface Props {
    diff: string
    /** Draft comments, so the ones already made show under their line. */
    comments: PrReviewComment[]
    oncomment: (target: CommentTarget) => void
  }

  let { diff, comments, oncomment }: Props = $props()

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
    oncomment({
      file: file.path,
      line: row.newNo !== undefined ? String(row.newNo) : undefined,
      snippet: row.text,
    })
  }

  /** Draft comments already anchored to this exact line. */
  function commentsOn(file: DiffFile, row: DiffRow): PrReviewComment[] {
    if (row.newNo === undefined) return []
    return comments.filter((c) => c.file === file.path && parseLineAnchor(c.line) === row.newNo)
  }
</script>

<div class="flex flex-col gap-3 p-3" data-testid="pr-diff">
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
        class="flex w-full items-center gap-2 border-b border-zinc-800 px-3 py-2.5 text-left"
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
                      class="flex w-full min-w-full items-start gap-2 whitespace-pre px-2 py-[3px] text-left active:bg-zinc-700/60 {ROW_CLASS[row.kind]}"
                    >
                      <span class="w-9 flex-none select-none text-right text-[10px] text-zinc-600 tabular-nums"
                        >{row.newNo ?? ''}</span
                      >
                      <span class="flex-none">{row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ' '}</span>
                      <span>{row.text}</span>
                    </button>
                  {/if}
                  {#each commentsOn(file, row) as c (c.source + c.text)}
                    <div
                      class="mx-2 my-1 rounded-md border border-blue-500/30 bg-blue-500/10 px-2.5 py-1.5 font-sans text-[11px] leading-relaxed text-blue-100"
                      data-testid="inline-comment"
                    >
                      <span class="mr-1.5 rounded bg-blue-500/25 px-1 py-0.5 text-[8.5px] font-bold uppercase">{c.source}</span
                      >{c.text}
                    </div>
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
