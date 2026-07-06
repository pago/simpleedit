<script lang="ts">
  interface Props {
    checked: boolean
    disabled?: boolean
    label: string
    onchange: (value: boolean) => void
  }

  let { checked, disabled = false, label, onchange }: Props = $props()
</script>

<button
  type="button"
  role="switch"
  aria-checked={checked}
  aria-label={label}
  {disabled}
  onclick={() => onchange(!checked)}
  class="relative h-[22px] w-10 flex-none rounded-full transition-colors
    focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500
    {checked ? 'bg-blue-600' : 'bg-zinc-600'}
    {disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer'}"
>
  <span
    class="absolute top-0.5 left-0.5 h-[18px] w-[18px] rounded-full bg-white shadow transition-transform
      {checked ? 'translate-x-[18px]' : ''}"
  ></span>
</button>
