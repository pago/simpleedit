<script lang="ts">
  /**
   * The session's diff with its agent threads: tap a line on the new side to
   * start one, and every open thread on a line the diff holds shows under it.
   *
   * A thread starts as an op to main through the shared store, like every
   * other change to one; main decides when the agent reads it, so nothing here
   * touches a PTY.
   *
   * What is typed into a composer belongs to its line (`thread-drafts`), so it
   * survives the pane remounting this diff, and tapping another line opens
   * that line's own composer rather than moving the text. A remount may bring
   * a newer diff: a draft follows its line only while the line reads the same
   * (`locateLine`), and otherwise waits, detached, for a tap on a line. It is
   * never anchored to whatever code took its line number.
   */
  import MobileDiff from './MobileDiff.svelte'
  import ThreadCard from './ThreadCard.svelte'
  import { agentThreadsStore } from '../renderer/stores/agentThreads.svelte'
  import { parseUnifiedDiff, type DiffFile, type DiffRow } from '../shared/parseDiff'
  import type { AgentThread } from '../shared/agent-threads'
  import { canAnchor, diffAnchor, locateLine, rowKey, threadLine, threadsByRow, type DiffView } from './lib/diff-threads'
  import { diffKey, threadDrafts, type DraftLine } from './lib/thread-drafts.svelte'

  interface Props {
    diff: string
    sessionId: string
    view: DiffView
    /** The diff is on screen. A hidden expanded thread reads nothing. */
    visible: boolean
  }

  let { diff, sessionId, view, visible }: Props = $props()

  let files = $derived(parseUnifiedDiff(diff))
  /** A resolved thread stays under its line while it is expanded, so resolving one doesn't yank it away. */
  let expanded = $state<Set<string>>(new Set())
  let placed = $derived(
    threadsByRow(
      agentThreadsStore.forSession(sessionId).filter((t) => t.status === 'open' || expanded.has(t.id)),
      files,
      view,
    ),
  )

  let diffView = $state<MobileDiff>()

  /**
   * Scroll to `thread`'s row and show it expanded there. Resolves false when
   * this diff doesn't hold its line, rather than landing on a nearby one.
   */
  export async function revealThread(thread: AgentThread): Promise<boolean> {
    const line = threadLine(thread, files, view)
    if (line === null) return false
    expanded = new Set(expanded).add(thread.id)
    return (await diffView?.reveal(thread.anchor.path, line)) ?? false
  }

  let thisDiff = $derived(diffKey(sessionId, view))
  /** The open composer and the row it is on now, or `row: null` when its line can't be found again. */
  let composing = $derived.by(() => {
    const at = threadDrafts.openLine(thisDiff)
    if (!at) return null
    const file = files.find((f) => f.path === at.path)
    const line = file ? locateLine(file, at.line, at.text) : null
    const row = line === null ? undefined : file?.rows.find((r) => canAnchor(r) && r.newNo === line)
    if (!file || !row) return { at, key: null, file: null, row: null }
    return { at, key: rowKey(at.path, row.newNo!), file, row }
  })
  let draft = $derived(composing ? threadDrafts.get(thisDiff, composing.at) : '')
  let sending = $state(false)
  let error = $state<string | null>(null)

  function openComposer(at: DraftLine | null): void {
    threadDrafts.setOpenLine(thisDiff, at)
    error = null
  }

  function tap(file: DiffFile, row: DiffRow): void {
    if (composing?.key === rowKey(file.path, row.newNo!)) return openComposer(null)
    const at = { path: file.path, line: row.newNo!, text: row.text }
    // A detached draft is waiting for exactly this: the line it is about.
    if (composing && !composing.row && draft) {
      const own = threadDrafts.get(thisDiff, at)
      threadDrafts.set(thisDiff, at, own ? `${own}\n\n${draft}` : draft)
      threadDrafts.set(thisDiff, composing.at, '')
    }
    openComposer(at)
  }

  function cancel(): void {
    if (composing) threadDrafts.set(thisDiff, composing.at, '')
    openComposer(null)
  }

  function toggle(id: string): void {
    const next = new Set(expanded)
    if (!next.delete(id)) next.add(id)
    expanded = next
  }

  async function submit(): Promise<void> {
    const body = draft.trim()
    const at = composing
    if (!body || !at?.row || sending) return
    const anchor = diffAnchor(at.file, at.row, view)
    if (!anchor) return
    const where = thisDiff
    sending = true
    error = null
    try {
      const id = await agentThreadsStore.create({ sessionId, worktreePath: view.worktreePath.replace(/\/+$/, ''), anchor, body })
      expanded = new Set(expanded).add(id)
      threadDrafts.set(where, at.at, '')
      // The user may have moved to another line while this was sending; leave that one open.
      const still = threadDrafts.openLine(where)
      if (still?.path === at.at.path && still.line === at.at.line) threadDrafts.setOpenLine(where, null)
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      sending = false
    }
  }
</script>

{#if composing && !composing.row && draft}
  <div class="m-3 mb-0 space-y-2 rounded-lg border border-amber-900/60 bg-amber-950/30 p-3" data-testid="thread-composer-detached">
    <p class="text-xs leading-relaxed text-amber-300">
      Line {composing.at.line} of {composing.at.path} has changed since you started this comment. Tap a line to attach it there.
    </p>
    <textarea
      value={draft}
      oninput={(e) => threadDrafts.set(thisDiff, composing!.at, e.currentTarget.value)}
      rows="3"
      class="w-full resize-none rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-2 text-zinc-200 outline-none focus:border-blue-500"
      aria-label="Comment for the agent"
    ></textarea>
    <button
      type="button"
      class="min-h-11 w-full rounded-md border border-zinc-700 text-sm text-zinc-300 active:bg-zinc-800"
      onclick={cancel}>Discard</button
    >
  </div>
{/if}

<MobileDiff bind:this={diffView} {diff} ontap={tap} tappable={canAnchor}>
  {#snippet below(file, row)}
    {#if canAnchor(row)}
      {@const key = rowKey(file.path, row.newNo!)}
      {@const threads = placed.get(key) ?? []}
      {#if threads.length > 0}
        <ul class="my-1 w-full border-y border-zinc-800 bg-zinc-950 font-sans" data-testid="inline-threads">
          {#each threads as t (t.id)}
            <ThreadCard thread={t} expanded={expanded.has(t.id)} {visible} ontoggle={() => toggle(t.id)} />
          {/each}
        </ul>
      {/if}
      {#if composing?.key === key}
        <div class="w-full space-y-2 border-y border-zinc-800 bg-zinc-950 p-3 font-sans" data-testid="thread-composer">
          <!-- svelte-ignore a11y_autofocus -->
          <textarea
            value={draft}
            oninput={(e) => threadDrafts.set(thisDiff, composing!.at, e.currentTarget.value)}
            autofocus
            rows="3"
            class="w-full resize-none rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-2 text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-blue-500"
            placeholder="Ask the agent about line {row.newNo}…"
            aria-label="Comment for the agent"
          ></textarea>
          {#if error}
            <p role="alert" class="text-xs text-red-300">{error}</p>
          {/if}
          <div class="flex gap-2">
            <button
              type="button"
              class="min-h-11 flex-1 rounded-md bg-orange-600 text-sm font-medium text-white active:bg-orange-500 disabled:opacity-40"
              disabled={!draft.trim() || sending}
              onclick={submit}>Send to agent</button
            >
            <button
              type="button"
              class="min-h-11 flex-1 rounded-md border border-zinc-700 text-sm text-zinc-300 active:bg-zinc-800"
              onclick={cancel}>Cancel</button
            >
          </div>
        </div>
      {/if}
    {/if}
  {/snippet}
</MobileDiff>
