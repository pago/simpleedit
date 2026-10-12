<script lang="ts">
  /**
   * The Mac now ships a newer build than this page runs. Shown instead of
   * reloading when a reload would cost something, or after one did not help.
   */
  interface Props {
    onreload: () => void
  }

  let { onreload }: Props = $props()
</script>

<div class="flex-none px-3 pt-3" data-testid="update-banner">
  <div
    class="flex items-center gap-2 rounded-md border border-sky-900/60 bg-sky-950/30 px-3 py-2 text-xs text-sky-300"
  >
    <span class="min-w-0 flex-1">SimpleEdit was updated on your Mac.</span>
    <button
      type="button"
      onclick={onreload}
      data-testid="update-reload"
      class="flex-none px-1 font-semibold underline"
    >Reload</button>
  </div>
</div>
