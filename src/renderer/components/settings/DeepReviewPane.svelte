<script lang="ts">
  import { onMount } from 'svelte'
  import Toggle from './Toggle.svelte'
  import { refKey } from './model-format'
  import { DEEP_LENS_ORDER, DEEP_LENS_LABEL, type DeepLensId } from '../../../shared/screenprs'
  import type {
    ClaudeModel,
    CodexModel,
    OpenCodeModel,
    ModelDescriptor,
    ModelConfig,
    ModelRef,
    DeepReviewConfig,
    DeepLensSetting,
  } from '../../../shared/ipc-types'

  interface Option {
    key: string
    label: string
    ref: ModelRef
  }

  let claudeOptions = $state<Option[]>([])
  let localOptions = $state<Option[]>([])
  let codexOptions = $state<Option[]>([])
  let openCodeOptions = $state<Option[]>([])
  let deepReview = $state<DeepReviewConfig>({ lenses: {} })
  let inheritLabel = $state('Haiku 4.5')
  let loading = $state(true)

  const byKey = $derived(
    new Map<string, ModelRef>([...claudeOptions, ...codexOptions, ...openCodeOptions, ...localOptions].map((o) => [o.key, o.ref]))
  )

  const LENS_DESC: Record<DeepLensId, string> = {
    soundness: 'Bugs, logic errors, edge cases, error handling. Highest-stakes — worth a stronger model.',
    intent: 'Does the implementation match the PR’s stated intent? Diff-only; a local model handles it well.',
    tests: 'Coverage for the changed behavior. Diff-only; local is fine.',
    types: 'Unsafe casts, `any` leaks, type regressions.',
    architecture: 'Layering, coupling, leaky abstractions. Off by default — enable for risky PRs.',
  }

  onMount(() => {
    let cancelled = false
    void (async () => {
      const [claude, codex, openCode, installed, config]: [ClaudeModel[], CodexModel[], OpenCodeModel[], ModelDescriptor[], ModelConfig] = await Promise.all([
        window.api.invoke('models:claude'),
        window.api.invoke('models:codex').catch(() => [] as CodexModel[]),
        window.api.invoke('models:opencode').catch(() => [] as OpenCodeModel[]),
        window.api.invoke('models:installed').catch(() => [] as ModelDescriptor[]),
        window.api.invoke('models:config-get'),
      ])
      if (cancelled) return
      claudeOptions = claude.map((m) => ({ key: refKey({ provider: 'anthropic', model: m.model }), label: m.displayName, ref: { provider: 'anthropic', model: m.model } }))
      codexOptions = [
        { key: refKey({ provider: 'openai' }), label: 'Configured default', ref: { provider: 'openai' } },
        ...codex.flatMap((m) => [undefined, ...m.supportedReasoningEfforts].map((effort) => {
          const ref: ModelRef = { provider: 'openai', model: m.model, ...(effort ? { reasoningEffort: effort } : {}) }
          return { key: refKey(ref), label: `${m.displayName}${effort ? ` · ${effort}` : ''}`, ref }
        })),
      ]
      openCodeOptions = [
        { key: refKey({ provider: 'opencode' }), label: 'Configured default', ref: { provider: 'opencode' } },
        ...openCode.flatMap((m) => (m.supportedReasoningEfforts.length ? [undefined, ...m.supportedReasoningEfforts] : [undefined]).map((effort) => {
          const ref: ModelRef = { provider: 'opencode', model: m.model, ...(effort ? { reasoningEffort: effort } : {}) }
          return { key: refKey(ref), label: `${m.displayName}${effort ? ` · ${effort}` : ''}`, ref }
        })),
      ]
      localOptions = installed.map((m) => ({ key: refKey({ provider: 'ollama', model: m.name }), label: m.name, ref: { provider: 'ollama', model: m.name } }))
      deepReview = config.deepReview ?? { lenses: {} }
      const sp = config.defaults.screenPrs
      if (!sp) inheritLabel = 'Haiku 4.5'
      else if (sp.provider === 'openai') {
        const name = sp.model ? (codex.find((c) => c.model === sp.model)?.displayName ?? sp.model) : 'configured default'
        inheritLabel = `Codex · ${name}${sp.reasoningEffort ? ` · ${sp.reasoningEffort}` : ''}`
      } else if (sp.provider === 'opencode') {
        const name = sp.model ? (openCode.find((c) => c.model === sp.model)?.displayName ?? sp.model) : 'configured default'
        inheritLabel = `OpenCode · ${name}${sp.reasoningEffort ? ` · ${sp.reasoningEffort}` : ''}`
      } else if (sp.provider === 'anthropic') {
        inheritLabel = claude.find((c) => c.model === sp.model)?.displayName ?? sp.model
      } else {
        inheritLabel = sp.model
      }
      loading = false
    })()
    return () => {
      cancelled = true
    }
  })

  async function persist(next: DeepReviewConfig): Promise<void> {
    // $state.snapshot: strip Svelte proxies before the IPC structured-clone.
    const config = await window.api.invoke('models:config-set', { deepReview: $state.snapshot(next) })
    deepReview = config.deepReview ?? { lenses: {} }
  }
  function setting(l: DeepLensId): DeepLensSetting {
    return deepReview.lenses[l] ?? { enabled: false }
  }
  function toggleLens(l: DeepLensId, enabled: boolean): void {
    void persist({ ...deepReview, lenses: { ...deepReview.lenses, [l]: { ...setting(l), enabled } } })
  }
  function setLensModel(l: DeepLensId, key: string): void {
    const ref = key ? byKey.get(key) : undefined
    void persist({ ...deepReview, lenses: { ...deepReview.lenses, [l]: { ...setting(l), model: ref } } })
  }
  function setSynthModel(key: string): void {
    void persist({ ...deepReview, synthesisModel: key ? byKey.get(key) : undefined })
  }
  const modelKey = (m?: ModelRef): string => (m ? refKey(m) : '')
</script>

{#snippet modelSelect(current: string, onpick: (key: string) => void, label: string)}
  <div class="relative">
    <select
      aria-label={label}
      value={current}
      onchange={(e) => onpick(e.currentTarget.value)}
      class="min-w-[210px] appearance-none rounded-lg border border-zinc-600 bg-zinc-900 py-1.5 pl-3 pr-8 font-mono text-[12.5px] text-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500"
    >
      <option value="">Inherit ({inheritLabel})</option>
      {#if claudeOptions.length}
        <optgroup label="Claude (cloud)">
          {#each claudeOptions as opt (opt.key)}<option value={opt.key}>{opt.label}</option>{/each}
        </optgroup>
      {/if}
      <optgroup label="Codex (cloud)">
        {#each codexOptions as opt (opt.key)}<option value={opt.key}>{opt.label}</option>{/each}
      </optgroup>
      <optgroup label="OpenCode (cloud)">
        {#each openCodeOptions as opt (opt.key)}<option value={opt.key}>{opt.label}</option>{/each}
      </optgroup>
      {#if localOptions.length}
        <optgroup label="Local (Ollama)">
          {#each localOptions as opt (opt.key)}<option value={opt.key}>{opt.label}</option>{/each}
        </optgroup>
      {/if}
    </select>
    <svg class="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
  </div>
{/snippet}

<div>
  <h1 class="text-xl font-semibold tracking-tight text-zinc-100">Deep Review</h1>
  <p class="mt-1 max-w-[64ch] text-[13px] text-zinc-400">
    A chosen PR’s thorough pass fans out these <span class="text-zinc-200">lenses</span>, then a synthesis step
    dedups and ranks them. Each lens runs on its own model — keep the cheap ones local, escalate only what earns it.
    “Inherit” uses your Screen PRs triage model (<span class="font-mono text-zinc-300">{inheritLabel}</span>).
  </p>

  {#if loading}
    <p class="mt-8 text-sm text-zinc-500">Loading…</p>
  {:else}
    <div class="mt-5 flex max-w-[640px] flex-col">
      {#each DEEP_LENS_ORDER as lens (lens)}
        {@const s = setting(lens)}
        <div class="grid grid-cols-[auto_1fr_auto] items-center gap-4 border-b border-zinc-800 py-3.5 last:border-b-0">
          <Toggle checked={s.enabled} label="Enable {DEEP_LENS_LABEL[lens]}" onchange={(v) => toggleLens(lens, v)} />
          <div class:opacity-50={!s.enabled}>
            <div class="text-sm font-semibold text-zinc-100">{DEEP_LENS_LABEL[lens]}</div>
            <div class="mt-0.5 text-[12px] text-zinc-400">{LENS_DESC[lens]}</div>
          </div>
          <div class:opacity-50={!s.enabled} class:pointer-events-none={!s.enabled}>
            {@render modelSelect(modelKey(s.model), (k) => setLensModel(lens, k), `Model for ${DEEP_LENS_LABEL[lens]}`)}
          </div>
        </div>
      {/each}

      <div class="grid grid-cols-[auto_1fr_auto] items-center gap-4 border-t border-zinc-700 pt-4">
        <div></div>
        <div>
          <div class="text-sm font-semibold text-zinc-100">Synthesis</div>
          <div class="mt-0.5 text-[12px] text-zinc-400">Merges & ranks the lens findings, dropping noise. Local is fine.</div>
        </div>
        {@render modelSelect(modelKey(deepReview.synthesisModel), setSynthModel, 'Model for synthesis')}
      </div>
    </div>

    <div class="mt-6 max-w-[640px] rounded-lg border border-blue-800/50 bg-blue-950/40 px-4 py-3 text-[12.5px] leading-relaxed text-zinc-200">
      Local lenses run <span class="font-semibold text-blue-400">sequentially</span> (one GPU); cloud lenses run in
      <span class="font-semibold text-blue-400">parallel</span>. A run-of-the-mill PR reviewed entirely on a local
      model spins up no cloud calls — escalate <span class="font-mono">soundness</span> or
      <span class="font-mono">architecture</span> to a cloud model only when a PR warrants it.
    </div>
  {/if}
</div>
