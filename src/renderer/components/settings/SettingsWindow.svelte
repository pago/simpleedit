<script lang="ts">
  import ModelsPane from './ModelsPane.svelte'
  import DefaultModelPane from './DefaultModelPane.svelte'

  type PaneId = 'models' | 'defaults'
  let active = $state<PaneId>('models')

  const NAV: { id: PaneId; label: string }[] = [
    { id: 'models', label: 'Models' },
    { id: 'defaults', label: 'Default Model' },
  ]
</script>

<div class="flex h-full flex-col bg-zinc-950 text-zinc-100">
  <!-- Title bar (drag region; traffic lights are OS-drawn on the left) -->
  <div class="drag-region flex h-9 flex-none items-center justify-center border-b border-zinc-800 bg-zinc-900">
    <span class="text-xs font-semibold text-zinc-400">Settings — SimpleEdit</span>
  </div>

  <div class="flex min-h-0 flex-1">
    <!-- Left nav -->
    <nav class="flex w-52 flex-none flex-col gap-0.5 border-r border-zinc-800 bg-zinc-900 p-2.5" aria-label="Settings sections">
      <div class="px-2.5 pb-2 pt-1.5 text-[11px] font-bold uppercase tracking-wider text-zinc-500">Settings</div>
      {#each NAV as item (item.id)}
        {@const isActive = active === item.id}
        <button
          type="button"
          aria-current={isActive ? 'page' : undefined}
          onclick={() => (active = item.id)}
          class="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13.5px] transition-colors
            {isActive
              ? 'bg-blue-950/60 font-semibold text-blue-400'
              : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100'}"
        >
          {#if item.id === 'models'}
            <svg class="h-4 w-4 flex-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
              <rect x="3" y="4" width="18" height="4" rx="1" /><rect x="3" y="10" width="18" height="4" rx="1" /><rect x="3" y="16" width="18" height="4" rx="1" />
            </svg>
          {:else}
            <svg class="h-4 w-4 flex-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
              <path d="M12 3v4M12 17v4M3 12h4M17 12h4" /><circle cx="12" cy="12" r="3.2" />
            </svg>
          {/if}
          {item.label}
        </button>
      {/each}
      <div class="flex-1"></div>
      <p class="px-2.5 py-2 text-[11px] leading-snug text-zinc-500">
        Local models run through Ollama; Claude models run on your plan.
      </p>
    </nav>

    <!-- Content -->
    <div class="min-w-0 flex-1 overflow-y-auto px-6 pb-8 pt-6">
      {#if active === 'models'}
        <ModelsPane />
      {:else}
        <DefaultModelPane />
      {/if}
    </div>
  </div>
</div>
