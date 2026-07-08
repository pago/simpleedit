<script lang="ts">
  import type { AgentModel } from '../lib/agentModels'

  // Main action starts with the remembered model; the caret (or right-click on
  // the main) opens a Cloud/Local model menu. Shared by "Discuss with Agent" and
  // the sidebar "✦ Agent" button.
  let {
    label,
    icon = '',
    models,
    selectedId = $bindable(),
    onstart,
    disabled = false,
    busy = false,
    size = 'md',
    tone = 'default',
    extraItems = [],
    onextra = () => {},
  }: {
    label: string
    icon?: string
    models: AgentModel[]
    selectedId: string | null
    onstart: (m: AgentModel) => void
    disabled?: boolean
    busy?: boolean
    size?: 'sm' | 'md'
    /** 'agent' tints the main label orange (matches the sidebar ✦ Agent accent). */
    tone?: 'default' | 'agent'
    /** Non-model actions shown atop the menu (e.g. "New Agent View session"). */
    extraItems?: { id: string; label: string }[]
    onextra?: (id: string) => void
  } = $props()

  const mainCls =
    size === 'sm'
      ? 'h-5 gap-1 px-1.5 text-[11px]'
      : 'gap-1.5 px-3 py-1 text-xs font-medium'
  const caretCls = size === 'sm' ? 'h-5 px-1 text-[11px]' : 'px-1.5 py-1 text-xs'
  const toneCls = tone === 'agent' ? 'text-orange-400/80 hover:text-orange-300' : 'text-zinc-200'

  let menu = $state<{ x: number; y: number } | null>(null)
  let selected = $derived(models.find((m) => m.id === selectedId) ?? models[0])

  function openMenu(e: MouseEvent): void {
    e.preventDefault()
    e.stopPropagation()
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    menu = { x: Math.min(r.left, window.innerWidth - 240), y: r.bottom + 4 }
  }
  function pick(m: AgentModel): void {
    selectedId = m.id
    menu = null
    onstart(m)
  }
  const cloud = $derived(models.filter((m) => m.tier === 'cloud'))
  const local = $derived(models.filter((m) => m.tier === 'local'))
</script>

<span class="inline-flex">
  <button
    class="flex items-center rounded-l-md border border-r-0 border-zinc-700 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 {mainCls} {toneCls}"
    {disabled}
    title={selected ? `Start with ${selected.label} (right-click to choose)` : label}
    onclick={() => selected && onstart(selected)}
    oncontextmenu={openMenu}
  >
    {#if busy}
      <span class="h-3 w-3 animate-spin rounded-full border-2 border-zinc-600 border-t-zinc-300"></span>
    {:else if icon}
      <span>{icon}</span>
    {/if}
    {label}{selected ? ` · ${selected.label}` : ''}
  </button>
  <button
    class="rounded-r-md border border-zinc-700 bg-zinc-800 text-zinc-400 hover:bg-zinc-700 disabled:opacity-50 {caretCls}"
    {disabled}
    aria-haspopup="menu"
    aria-label="Choose model"
    onclick={openMenu}
  >
    ▾
  </button>
</span>

{#if menu}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="fixed inset-0 z-40" onclick={() => (menu = null)}></div>
  <div class="fixed z-50 min-w-[220px] rounded-lg border border-zinc-700 bg-zinc-900 p-1.5 shadow-2xl" style:top="{menu.y}px" style:left="{menu.x}px">
    {#each extraItems as item (item.id)}
      <button class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100" onclick={() => { menu = null; onextra(item.id) }}>
        {item.label}
      </button>
    {/each}
    {#if extraItems.length && (cloud.length || local.length)}<div class="my-1 border-t border-zinc-800"></div>{/if}
    {#if cloud.length}
      <div class="px-2 pb-1 pt-1.5 text-[9px] uppercase tracking-wider text-zinc-600">Cloud</div>
      {#each cloud as m (m.id)}
        <button class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100" onclick={() => pick(m)}>
          <span class="h-1.5 w-1.5 flex-none rounded-full bg-orange-400"></span>{m.label}
          {#if m.id === selectedId}<span class="ml-auto text-emerald-400">✓</span>{/if}
        </button>
      {/each}
    {/if}
    {#if local.length}
      <div class="px-2 pb-1 pt-1.5 text-[9px] uppercase tracking-wider text-zinc-600">Local</div>
      {#each local as m (m.id)}
        <button class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100" onclick={() => pick(m)}>
          <span class="h-1.5 w-1.5 flex-none rounded-full bg-sky-400"></span>{m.label}
          {#if m.id === selectedId}<span class="ml-auto text-emerald-400">✓</span>{/if}
        </button>
      {/each}
    {/if}
  </div>
{/if}
