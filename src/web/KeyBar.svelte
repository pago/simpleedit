<script lang="ts">
  /**
   * The keys a phone keyboard does not have and a TUI cannot do without.
   *
   * Claude and Codex present real menus — plan approval, model selection — that
   * are driven by arrows, Enter, Esc and Tab. A software keyboard offers none
   * of them, which is the one gap that a real terminal on a phone otherwise
   * leaves unusable. Each button writes exactly the bytes a physical key sends;
   * nothing here interprets what is on screen.
   */
  interface Props {
    onkey: (bytes: string) => void
    disabled?: boolean
  }

  let { onkey, disabled = false }: Props = $props()

  const KEYS: { label: string; bytes: string; title: string }[] = [
    { label: '↑', bytes: '\x1b[A', title: 'Up' },
    { label: '↓', bytes: '\x1b[B', title: 'Down' },
    { label: '⏎', bytes: '\r', title: 'Enter' },
    { label: 'Esc', bytes: '\x1b', title: 'Escape' },
    { label: '⇥', bytes: '\t', title: 'Tab' },
  ]
</script>

<div class="flex items-stretch gap-1.5" data-testid="key-bar">
  {#each KEYS as key (key.label)}
    <button
      type="button"
      {disabled}
      title={key.title}
      aria-label={key.title}
      data-testid="key-{key.title.toLowerCase()}"
      onclick={() => onkey(key.bytes)}
      class="min-h-11 flex-1 rounded-lg border border-zinc-700 bg-zinc-800 text-sm font-medium text-zinc-200
             active:bg-zinc-700 disabled:opacity-40"
    >{key.label}</button>
  {/each}
</div>
