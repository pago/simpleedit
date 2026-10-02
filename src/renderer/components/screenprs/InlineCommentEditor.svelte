<script lang="ts">
  /**
   * The editor that opens under a diff line: writes a new line comment, or
   * edits one already in the draft.
   *
   * Text in the field is not in the draft yet, so nothing but this editor
   * holds it. Every way out — Cancel, Esc, and the parent opening another
   * editor through `confirmLeave` — asks before throwing a change away.
   */
  import { tick } from 'svelte'

  interface Props {
    /** Bound so the text survives a remount, e.g. when a shift-click moves the editor under a range's new last row. */
    text: string
    /** The comment's saved text when editing one; a change from it is what gets held. */
    initial?: string
    /** What is being commented on, e.g. `Line 12` or `Deleted lines 4–6`. */
    label: string
    onsubmit: (text: string) => void
    oncancel: () => void
    /** Offered only when editing: takes the comment out of the draft. */
    ondelete?: () => void
  }

  let { text = $bindable(), initial = '', label, onsubmit, oncancel, ondelete }: Props = $props()

  let field = $state<HTMLTextAreaElement>()
  let keepButton = $state<HTMLButtonElement>()
  /** Where to go once the user agrees to discard; set while the confirm shows. */
  let pendingLeave = $state<(() => void) | null>(null)

  let editing = $derived(initial !== '')
  let canSubmit = $derived(text.trim() !== '' && text !== initial)

  $effect(() => {
    field?.focus()
  })

  /** Runs `leave` now, or once the user confirms throwing away a change. */
  export function confirmLeave(leave: () => void): void {
    if (text.trim() === initial.trim()) {
      leave()
      return
    }
    pendingLeave = leave
    void tick().then(() => keepButton?.focus())
  }

  function keepEditing(): void {
    pendingLeave = null
    field?.focus()
  }

  function discard(): void {
    const leave = pendingLeave
    pendingLeave = null
    leave?.()
  }

  function submit(): void {
    if (canSubmit) onsubmit(text.trim())
  }

  function onkeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      submit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (pendingLeave) keepEditing()
      else confirmLeave(oncancel)
    }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="mx-3 my-1.5 rounded-md border border-blue-500/40 bg-zinc-900 p-2 font-sans"
  {onkeydown}
  data-testid="inline-comment-editor"
>
  <div class="mb-1 text-[10.5px] text-zinc-500">{label}</div>
  <textarea
    bind:this={field}
    bind:value={text}
    rows="3"
    class="w-full resize-y rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-[12px] text-zinc-200 outline-none focus:border-blue-500"
    placeholder="Leave a comment…"
    aria-label="Comment text"
  ></textarea>
  {#if pendingLeave}
    <div class="mt-1.5 flex items-center gap-2 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-200" data-testid="inline-comment-discard">
      <span class="flex-1">{editing ? 'Discard your changes? The comment keeps the text it had.' : 'Discard this comment? It isn’t in the review yet.'}</span>
      <button bind:this={keepButton} type="button" class="rounded px-2 py-0.5 text-zinc-300 hover:bg-zinc-800" onclick={keepEditing}>Keep editing</button>
      <button type="button" class="rounded border border-red-500/40 px-2 py-0.5 text-red-300 hover:bg-red-500/15" onclick={discard}>Discard</button>
    </div>
  {:else}
    <div class="mt-1.5 flex items-center gap-2">
      {#if ondelete}
        <button type="button" class="rounded px-2 py-0.5 text-[11px] text-red-400 hover:bg-red-500/10" onclick={ondelete}>Delete</button>
      {/if}
      <span class="flex-1 text-[10px] text-zinc-600">⌘↵ to {editing ? 'save' : 'add'} · Esc to cancel</span>
      <button type="button" class="rounded border border-zinc-700 px-2.5 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-800" onclick={() => confirmLeave(oncancel)}>Cancel</button>
      <button
        type="button"
        class="rounded border border-blue-500 bg-blue-700 px-2.5 py-0.5 text-[11px] font-medium text-blue-50 hover:bg-blue-600 disabled:cursor-default disabled:opacity-50"
        disabled={!canSubmit}
        onclick={submit}
      >{editing ? 'Save' : 'Add comment'}</button>
    </div>
  {/if}
</div>
