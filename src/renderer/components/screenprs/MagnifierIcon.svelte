<script lang="ts">
  // Monochrome line glyph (inherits currentColor) — matches the app's text-glyph
  // aesthetic rather than a coloured emoji.
  let { class: cls = 'h-4 w-4' }: { class?: string } = $props()
</script>

<svg class={cls} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
  <circle cx="6.75" cy="6.75" r="4.25" />
  <line x1="9.9" y1="9.9" x2="13.5" y2="13.5" stroke-linecap="round" />
</svg>
