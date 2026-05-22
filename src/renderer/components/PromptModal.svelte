<script lang="ts">
  interface Props {
    title: string
    label?: string
    defaultValue?: string
    /** Optional pre-selected portion of `defaultValue`, e.g. the basename without extension. */
    selectionRange?: [number, number]
    confirmLabel?: string
    confirmTone?: 'default' | 'danger'
    /** Validator returns an error string, or null if value is valid. */
    validate?: (value: string) => string | null
    onsubmit: (value: string) => void
    oncancel: () => void
  }

  let {
    title,
    label,
    defaultValue = '',
    selectionRange,
    confirmLabel = 'OK',
    confirmTone = 'default',
    validate,
    onsubmit,
    oncancel,
  }: Props = $props()

  let value = $state(defaultValue)
  let inputEl: HTMLInputElement | undefined = $state()

  let validationError = $derived(validate ? validate(value) : null)
  let canSubmit = $derived(!validationError && value.trim().length > 0)

  $effect(() => {
    if (!inputEl) return
    inputEl.focus()
    if (selectionRange) {
      inputEl.setSelectionRange(selectionRange[0], selectionRange[1])
    } else {
      inputEl.select()
    }
  })

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      oncancel()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      submit()
    }
  }

  function submit(): void {
    if (!canSubmit) return
    onsubmit(value)
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div
  class="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
  onclick={oncancel}
>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div
    class="w-[420px] rounded-md border border-zinc-700 bg-zinc-900 p-4 shadow-2xl"
    onclick={(e) => e.stopPropagation()}
    role="dialog"
    aria-modal="true"
    aria-label={title}
  >
    <h2 class="mb-3 text-sm font-medium text-zinc-100">{title}</h2>
    {#if label}
      <label for="prompt-modal-input" class="mb-1 block text-xs text-zinc-400">{label}</label>
    {/if}
    <input
      id="prompt-modal-input"
      bind:this={inputEl}
      bind:value
      onkeydown={handleKeydown}
      class="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-blue-500"
    />
    {#if validationError && value.length > 0}
      <p class="mt-1 text-xs text-red-400">{validationError}</p>
    {/if}
    <div class="mt-4 flex justify-end gap-2">
      <button
        class="rounded border border-zinc-700 px-3 py-1 text-sm text-zinc-300 hover:bg-zinc-800"
        onclick={oncancel}
      >
        Cancel
      </button>
      <button
        class={`rounded px-3 py-1 text-sm text-white disabled:opacity-50 ${
          confirmTone === 'danger'
            ? 'bg-red-600 enabled:hover:bg-red-500'
            : 'bg-blue-600 enabled:hover:bg-blue-500'
        }`}
        onclick={submit}
        disabled={!canSubmit}
      >
        {confirmLabel}
      </button>
    </div>
  </div>
</div>
