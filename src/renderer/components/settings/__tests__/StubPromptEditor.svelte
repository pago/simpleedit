<script lang="ts">
  let { value, onchange, label }: { value: string; onchange: (value: string) => void; label: string } = $props()
</script>

<textarea aria-label={label} {value} oninput={(e) => onchange(e.currentTarget.value)}></textarea>
