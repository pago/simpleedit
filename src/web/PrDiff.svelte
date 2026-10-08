<script lang="ts">
  /**
   * The phone diff for a pull request review, with every line a tap target.
   *
   * A tap anchors to the side of the diff the row lives on: a deletion exists
   * only in the old file, so it anchors to its OLD number on `LEFT`; an
   * addition or a context line anchors to its new number on `RIGHT`.
   *
   * Tapping a draft comment under its line edits it.
   */
  import MobileDiff from './MobileDiff.svelte'
  import type { DiffFile, DiffRow } from '../shared/parseDiff'
  import { parseLineRange, type PrReviewComment } from '../shared/screenprs'
  import type { CommentTarget } from './lib/prs.svelte'

  interface Props {
    diff: string
    /** Draft comments, so the ones already made show under their line. */
    comments: PrReviewComment[]
    oncomment: (target: CommentTarget) => void
    onedit: (comment: PrReviewComment) => void
  }

  let { diff, comments, oncomment, onedit }: Props = $props()

  let view = $state<MobileDiff>()

  function tap(file: DiffFile, row: DiffRow): void {
    const left = row.kind === 'del'
    const n = left ? row.oldNo : row.newNo
    if (n === undefined) return
    oncomment({ file: file.path, line: String(n), side: left ? 'LEFT' : 'RIGHT', snippet: row.text })
  }

  /** See `MobileDiff.reveal`. */
  export function reveal(path: string, line?: string | number): Promise<boolean> {
    return view?.reveal(path, line) ?? Promise.resolve(false)
  }

  /**
   * Draft comments that end on this row — a range sits under its last line,
   * as on the desktop. A context row carries both numbers, and each side is
   * matched against its own: old line 12 and new line 12 are different lines.
   */
  function commentsOn(file: DiffFile, row: DiffRow): PrReviewComment[] {
    if (row.kind === 'hunk') return []
    return comments.filter((c) => {
      if (c.file !== file.path) return false
      const n = c.side === 'LEFT' ? row.oldNo : row.newNo
      return n !== undefined && parseLineRange(c.line)?.end === n
    })
  }
</script>

<MobileDiff bind:this={view} {diff} testid="pr-diff" ontap={tap}>
  {#snippet below(file, row)}
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
  {/snippet}
</MobileDiff>
