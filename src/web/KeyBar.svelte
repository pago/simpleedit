<script lang="ts">
  /**
   * The keys a phone keyboard does not have and a TUI cannot do without.
   *
   * Claude and Codex present real menus — plan approval, model selection — that
   * are driven by arrows, Enter, Esc and Tab. A software keyboard offers none
   * of them, which is the one gap that a real terminal on a phone otherwise
   * leaves unusable. Nothing here interprets what is on screen.
   *
   * The bar names the KEY, not the bytes. What an arrow sends depends on
   * whether the terminal is in application-cursor-keys mode, which only the
   * terminal knows — so the encoding lives next to it, and this stays a row of
   * buttons.
   */
  import type { AccessoryKey } from './lib/keys'

  interface Props {
    onkey: (key: AccessoryKey) => void
    disabled?: boolean
  }

  let { onkey, disabled = false }: Props = $props()

  const KEYS: { label: string; key: AccessoryKey; title: string }[] = [
    { label: '↑', key: 'up', title: 'Up' },
    { label: '↓', key: 'down', title: 'Down' },
    { label: '⏎', key: 'enter', title: 'Enter' },
    { label: 'Esc', key: 'escape', title: 'Escape' },
    { label: '⇥', key: 'tab', title: 'Tab' },
  ]
</script>

<div class="flex items-stretch gap-1.5" data-testid="key-bar">
  {#each KEYS as entry (entry.key)}
    <button
      type="button"
      {disabled}
      title={entry.title}
      aria-label={entry.title}
      data-testid="key-{entry.key}"
      onclick={() => onkey(entry.key)}
      class="min-h-11 flex-1 rounded-lg border border-zinc-700 bg-zinc-800 text-sm font-medium text-zinc-200
             active:bg-zinc-700 disabled:opacity-40"
    >{entry.label}</button>
  {/each}
</div>
