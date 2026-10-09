<script lang="ts">
  let { value, onchange, label, autofocus = false }: { value: string; onchange: (value: string) => void; label: string; autofocus?: boolean } = $props()
  let el: HTMLTextAreaElement | undefined = $state()
  $effect(() => {
    if (autofocus) el?.focus()
  })
</script>

<textarea bind:this={el} aria-label={label} {value} oninput={(e) => onchange(e.currentTarget.value)}></textarea>
