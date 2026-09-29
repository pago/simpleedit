<script lang="ts">
  /**
   * "Discard this?" — a centred modal, because it is a confirm and not a sheet.
   * Keep is focused: the safe answer is the one a stray tap gives.
   */
  interface Props {
    title: string
    body: string
    testid: string
    onkeep: () => void
    ondiscard: () => void
  }

  let { title, body, testid, onkeep, ondiscard }: Props = $props()
</script>

<div class="fixed inset-0 z-50 flex items-center justify-center p-6">
  <div class="absolute inset-0 bg-black/70"></div>
  <div
    role="dialog"
    aria-modal="true"
    aria-label={title}
    tabindex="-1"
    class="relative w-full max-w-xs rounded-xl border border-zinc-800 bg-zinc-900 p-4"
    data-testid={testid}
  >
    <h3 class="text-sm font-semibold text-zinc-100">{title}</h3>
    <p class="mt-1 text-[11px] leading-relaxed text-zinc-400">{body}</p>
    <div class="mt-4 flex gap-2">
      <!-- svelte-ignore a11y_autofocus -->
      <button
        type="button"
        autofocus
        onclick={onkeep}
        class="min-h-10 flex-1 rounded-lg border border-zinc-700 text-sm text-zinc-200"
      >Keep</button>
      <button
        type="button"
        onclick={ondiscard}
        data-testid="{testid}ed"
        class="min-h-10 flex-1 rounded-lg bg-red-600 text-sm font-semibold text-white"
      >Discard</button>
    </div>
  </div>
</div>
