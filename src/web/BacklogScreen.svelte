<script lang="ts">
  /**
   * The project's backlog on the phone: prepared prompts to start later. Tap a
   * row to read or edit it; Start asks once, because starting spends an agent.
   * Reordering is the desk's (or an agent's) job.
   */
  import { backlogStore } from '../renderer/stores/backlog.svelte'
  import { labelFromBrief } from '../shared/brief'
  import { SESSION_CREATE_UNWITNESSED, type SessionCreateResult } from '../shared/ipc-types'
  import type { BacklogItem } from '../shared/backlog'

  interface Props {
    connected: boolean
    onopen: (itemId: string) => void
    onstarted: (created: SessionCreateResult) => void
  }

  let { connected, onopen, onstarted }: Props = $props()

  /** The row whose Start is asking "start now?". */
  let confirming = $state<string | null>(null)
  let starting = $state<string | null>(null)
  let errors = $state<Record<string, string>>({})

  const items = $derived(backlogStore.items)

  function title(item: BacklogItem): string {
    return item.label || labelFromBrief(item.prompt) || item.prompt.split('\n')[0] || 'Untitled'
  }

  function modelOf(item: BacklogItem): string {
    const t = item.target
    if (!t) return 'Default agent'
    const model = t.provider === 'claude' ? t.model?.model : t.model
    return model ? `${t.provider} · ${model}` : t.provider
  }

  async function start(item: BacklogItem): Promise<void> {
    confirming = null
    starting = item.id
    const { [item.id]: _, ...rest } = errors
    errors = rest
    try {
      onstarted(await backlogStore.start(item.id))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // Recorded on the item by main, which says it better; the rest shows here.
      if (!message.includes(SESSION_CREATE_UNWITNESSED) && !backlogStore.get(item.id)?.lastStart) {
        errors = { ...errors, [item.id]: message }
      }
    } finally {
      starting = null
    }
  }
</script>

<div class="min-h-0 flex-1 overflow-y-auto px-3 py-3" data-testid="backlog-screen">
  {#if items.length === 0}
    <p class="mt-12 px-6 text-center text-sm leading-relaxed text-zinc-500">
      Nothing queued. Tap + to save a prompt for later, or ask an agent to add one to the backlog.
    </p>
  {:else}
    <ul class="space-y-2">
      {#each items as item (item.id)}
        <li class="rounded-xl border border-zinc-800 bg-zinc-900" data-testid="backlog-row">
          <button type="button" onclick={() => onopen(item.id)} class="block w-full px-3 pt-2.5 pb-2 text-left">
            <div class="truncate text-[14px] text-zinc-100">{title(item)}</div>
            {#if item.prompt.trim()}
              <div class="mt-0.5 line-clamp-2 text-[12px] leading-snug text-zinc-500">{item.prompt}</div>
            {:else}
              <div class="mt-0.5 text-[12px] italic text-zinc-500">No prompt yet. Write one before starting.</div>
            {/if}
            <div class="mt-1.5 flex flex-wrap gap-1.5 text-[10px] text-zinc-400">
              <span class="rounded bg-zinc-800 px-1.5 py-0.5">{modelOf(item)}</span>
              {#if item.createdBy === 'agent'}<span class="py-0.5">by {item.createdBySession ?? 'an agent'}</span>{/if}
            </div>
            {#if item.lastStart?.outcome === 'unconfirmed'}
              <p class="mt-1.5 text-[11px] leading-relaxed text-amber-300">May have started — check Sessions before starting it again.</p>
            {:else if item.lastStart}
              <p class="mt-1.5 text-[11px] leading-relaxed text-red-300">Didn't start: {item.lastStart.reason}</p>
            {/if}
            {#if errors[item.id]}<p class="mt-1.5 text-[11px] text-red-300">{errors[item.id]}</p>{/if}
          </button>
          <div class="flex border-t border-zinc-800">
            {#if item.starting || starting === item.id}
              <span class="min-h-10 flex-1 py-2.5 text-center text-xs text-zinc-400">Starting…</span>
            {:else if confirming === item.id}
              <button type="button" onclick={() => (confirming = null)} class="min-h-10 flex-1 text-xs text-zinc-400">Not now</button>
              <button
                type="button"
                onclick={() => void start(item)}
                disabled={!connected}
                data-testid="backlog-start-confirm"
                class="min-h-10 flex-1 border-l border-zinc-800 text-xs font-semibold text-blue-300 disabled:opacity-40"
              >Start now</button>
            {:else}
              <button
                type="button"
                onclick={() => (confirming = item.id)}
                disabled={!connected || !item.prompt.trim()}
                title={item.prompt.trim() ? undefined : 'Write a prompt before starting this item.'}
                data-testid="backlog-start"
                class="min-h-10 flex-1 text-xs font-semibold text-zinc-200 disabled:opacity-40"
              >Start</button>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</div>
