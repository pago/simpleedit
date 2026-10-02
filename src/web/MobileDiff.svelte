<script lang="ts">
  /**
   * A unified diff, read-only, at phone width.
   *
   * Unified because there is no second column to put anything in: a
   * side-by-side split at ~390 CSS px gives each side about twenty characters,
   * which is not a diff, it is a puzzle. Long lines scroll inside their own
   * file's container so the PAGE never moves sideways — a horizontally
   * scrolling page on a touch screen fights every vertical swipe.
   *
   * Nothing here can act on the repository. Rows are not tap targets, because
   * there is nothing for a tap to do on this surface and a row that lights up
   * under a thumb promises otherwise.
   *
   * ⚠️ Convergence: `PrDiff.svelte` (pull-request review, on its own branch)
   * renders the same rows with tappable lines and inline draft comments. The
   * two should become one component with the tap handling optional; this is
   * deliberately the same structure so that lift is mechanical rather than a
   * rewrite.
   */
  import { parseUnifiedDiff, type DiffFile, type DiffRow } from '../shared/parseDiff'

  interface Props {
    diff: string
  }

  let { diff }: Props = $props()

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
</script>

<!-- Keyed by position, not by path: a parsed path is display data, and the
     whole list is re-derived from scratch whenever the diff string changes. -->
<div class="flex flex-col gap-3 p-3" data-testid="session-diff">
  {#if files.length === 0}
    <p class="px-1 py-4 text-sm text-zinc-500" data-testid="session-diff-empty">
      No textual changes here.
    </p>
  {/if}

  {#each files as file, index (index)}
    {@const open = isOpen(file.path)}
    {@const all = shownAll.has(file.path)}
    {@const rows = all ? file.rows : file.rows.slice(0, ROW_BUDGET)}
    <section
      class="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900"
      data-testid="session-diff-file"
    >
      <button
        type="button"
        onclick={() => toggle(file.path)}
        data-testid="session-diff-file-header"
        aria-expanded={open}
        class="flex w-full items-center gap-2 border-b border-zinc-800 px-3 py-2.5 text-left"
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
                <li
                  data-testid="session-diff-line"
                  data-line={row.newNo ?? ''}
                  class="flex min-w-full items-start gap-2 whitespace-pre px-2 py-[3px] {ROW_CLASS[row.kind]}"
                >
                  {#if row.kind === 'hunk'}
                    <span class="px-1">{row.text}</span>
                  {:else}
                    <span
                      class="w-9 flex-none select-none text-right text-[10px] tabular-nums text-zinc-600"
                      >{row.newNo ?? ''}</span
                    >
                    <span class="flex-none">{marker(row.kind)}</span>
                    <span>{row.text}</span>
                  {/if}
                </li>
              {/each}
            </ul>
          </div>
          {#if !all && file.rows.length > ROW_BUDGET}
            <button
              type="button"
              onclick={() => { shownAll = new Set(shownAll).add(file.path) }}
              data-testid="session-diff-show-all"
              class="w-full border-t border-zinc-800 px-3 py-2.5 text-[11px] text-blue-400"
              >Show the remaining {file.rows.length - ROW_BUDGET} lines</button
            >
          {/if}
        {/if}
      {/if}
    </section>
  {/each}
</div>
