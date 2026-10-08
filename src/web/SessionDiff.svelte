<script lang="ts">
  /**
   * The session's diff with its agent threads: tap a line on the new side to
   * start one, and every open thread on a line the diff holds shows under it.
   *
   * A thread starts as an op to main through the shared store, like every
   * other change to one; main decides when the agent reads it, so nothing here
   * touches a PTY.
   */
  import MobileDiff from './MobileDiff.svelte'
  import ThreadCard from './ThreadCard.svelte'
  import { agentThreadsStore } from '../renderer/stores/agentThreads.svelte'
  import { parseUnifiedDiff, type DiffFile, type DiffRow } from '../shared/parseDiff'
  import { canAnchor, diffAnchor, rowKey, threadsByRow, type DiffView } from './lib/diff-threads'

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

  let composing = $state<{ key: string; file: DiffFile; row: DiffRow } | null>(null)
  let draft = $state('')
  let sending = $state(false)
  let error = $state<string | null>(null)

  function tap(file: DiffFile, row: DiffRow): void {
    const key = rowKey(file.path, row.newNo!)
    composing = composing?.key === key ? null : { key, file, row }
    error = null
  }

  function toggle(id: string): void {
    const next = new Set(expanded)
    if (!next.delete(id)) next.add(id)
    expanded = next
  }

  async function submit(): Promise<void> {
    const body = draft.trim()
    const at = composing
    if (!body || !at || sending) return
    const anchor = diffAnchor(at.file, at.row, view)
    if (!anchor) return
    sending = true
    error = null
    try {
      const id = await agentThreadsStore.create({ sessionId, worktreePath: view.worktreePath.replace(/\/+$/, ''), anchor, body })
      expanded = new Set(expanded).add(id)
      draft = ''
      composing = null
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      sending = false
    }
  }
</script>

<MobileDiff {diff} ontap={tap} tappable={canAnchor}>
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
            bind:value={draft}
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
              onclick={() => { composing = null; error = null }}>Cancel</button
            >
          </div>
        </div>
      {/if}
    {/if}
  {/snippet}
</MobileDiff>
