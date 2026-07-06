<script lang="ts">
  import { onMount } from 'svelte'
  import type {
    ClaudeModel,
    ModelConfig,
    ModelDescriptor,
    ModelFeatureKey,
    ModelRef,
  } from '../../../shared/ipc-types'
  import { refKey } from './model-format'

  interface Option {
    key: string
    label: string
    ref: ModelRef
  }

  let claudeOptions = $state<Option[]>([])
  let localOptions = $state<Option[]>([])
  let defaults = $state<Partial<Record<ModelFeatureKey, ModelRef>>>({})
  let loading = $state(true)

  // Every option, for resolving a selected key back to its ModelRef.
  const byKey = $derived(
    new Map<string, ModelRef>(
      [...claudeOptions, ...localOptions].map((o) => [o.key, o.ref])
    )
  )

  function selectedKey(feature: ModelFeatureKey): string {
    const ref = defaults[feature]
    return ref ? refKey(ref) : ''
  }

  onMount(() => {
    let cancelled = false
    void (async () => {
      const [claude, installed, config]: [ClaudeModel[], ModelDescriptor[], ModelConfig] =
        await Promise.all([
          window.api.invoke('models:claude'),
          window.api.invoke('models:installed').catch(() => [] as ModelDescriptor[]),
          window.api.invoke('models:config-get'),
        ])
      if (cancelled) return
      claudeOptions = claude.map((m) => {
        const ref: ModelRef = { provider: 'anthropic', model: m.model }
        return { key: refKey(ref), label: m.displayName, ref }
      })
      // Bounded tasks don't need tool-calling, so review-only models are eligible too.
      localOptions = installed.map((m) => {
        const ref: ModelRef = { provider: 'ollama', model: m.name }
        return { key: refKey(ref), label: m.name, ref }
      })
      defaults = config.defaults
      loading = false
    })()
    return () => {
      cancelled = true
    }
  })

  async function setDefault(feature: ModelFeatureKey, key: string): Promise<void> {
    const ref = byKey.get(key)
    if (!ref) return
    const next = { ...defaults, [feature]: ref }
    const config = await window.api.invoke('models:config-set', { defaults: next })
    defaults = config.defaults
  }

  const FIELDS: { feature: ModelFeatureKey; label: string; desc: string }[] = [
    { feature: 'review', label: 'Review', desc: 'Diff review — the “what should I look at” pass.' },
    { feature: 'tour', label: 'Tour', desc: 'Codebase tour & summaries.' },
  ]
</script>

<div>
  <div>
    <h1 class="text-xl font-semibold tracking-tight text-zinc-100">Default Model</h1>
    <p class="mt-1 max-w-[62ch] text-[13px] text-zinc-400">
      The model used for SimpleEdit’s automated passes. These run often on low-stakes work — pick a
      cheap or local model here and keep your premium plan for the hard problems.
    </p>
  </div>

  {#if loading}
    <p class="mt-8 text-sm text-zinc-500">Loading…</p>
  {:else}
    <div class="mt-5 flex max-w-[560px] flex-col">
      {#each FIELDS as { feature, label, desc } (feature)}
        <div class="grid grid-cols-[1fr_auto] items-center gap-5 border-b border-zinc-800 py-4 last:border-b-0">
          <div>
            <div class="text-sm font-semibold text-zinc-100">{label}</div>
            <div class="mt-0.5 text-[12px] text-zinc-400">{desc}</div>
          </div>
          <div class="relative">
            <select
              aria-label="Default model for {label}"
              value={selectedKey(feature)}
              onchange={(e) => setDefault(feature, e.currentTarget.value)}
              class="min-w-[210px] appearance-none rounded-lg border border-zinc-600 bg-zinc-900 py-2 pl-3 pr-8 font-mono text-[13px] text-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500"
            >
              <option value="" disabled>Select a model…</option>
              {#if claudeOptions.length}
                <optgroup label="Claude (cloud)">
                  {#each claudeOptions as opt (opt.key)}
                    <option value={opt.key}>{opt.label}</option>
                  {/each}
                </optgroup>
              {/if}
              {#if localOptions.length}
                <optgroup label="Local (Ollama)">
                  {#each localOptions as opt (opt.key)}
                    <option value={opt.key}>{opt.label}</option>
                  {/each}
                </optgroup>
              {/if}
            </select>
            <svg
              class="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              aria-hidden="true"
            >
              <path d="M6 9l6 6 6-6" />
            </svg>
          </div>
        </div>
      {/each}
    </div>

    <div
      class="mt-6 max-w-[560px] rounded-lg border border-blue-800/50 bg-blue-950/40 px-4 py-3 text-[12.5px] leading-relaxed text-zinc-200"
    >
      Review and Tour are set <span class="font-semibold text-blue-400">independently</span> — e.g. a
      local model for Review (fires on every small change) and a cheap cloud model for Tour. Bounded
      tasks don’t need tool-calling, so <span class="font-semibold text-blue-400">review-only</span>
      local models are selectable here even though they can’t run the interactive agent.
    </div>
    <p class="mt-3 max-w-[560px] text-[11.5px] text-zinc-500">
      PR triage (screen-PRs) will appear here as a third task once it ships.
    </p>
  {/if}
</div>
